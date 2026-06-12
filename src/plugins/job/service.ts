/**
 * Job service — list, get, create (Freestyle/Folder), run, stop, log, status, update.
 * Ports legacy/cb/services/job_service.py
 */

import type { CloudBeesClient } from "../../core/api/types";
import { jobFromDict, buildFromDict } from "../../core/dtos/index";
import type { JobDTO, BuildDTO } from "../../core/dtos/index";
import {
  buildFreestyleXml,
  buildFolderXml,
  buildParametersProperty,
  extractPresendScriptFromXml,
} from "./xml-builder";
import {
  buildEmailPublisherBlock,
  parseEmailFilterMetadata,
  normalizeKeywords,
  normalizeRegex,
  validateRegex,
} from "../../domain/email";
import { escapeXml } from "../../domain/xml";
import { buildTimerTriggerBlock } from "../../domain/schedule";
import type { JobConfigSummary, StringParamDef } from "./types";
import { XMLParser } from "fast-xml-parser";

const _JOB_TREE = "jobs[_class,name,url,color,description,buildable,lastBuild[number,result,url]]";

// ---------------------------------------------------------------------------
// List / Get
// ---------------------------------------------------------------------------

export async function listJobs(client: CloudBeesClient): Promise<JobDTO[]> {
  const endpoint = `/api/json?tree=${_JOB_TREE}`;
  const cacheKey = `jobs.list.${client.baseUrl}`;
  const data = await client.get<Record<string, unknown>>(endpoint, { cacheKey });
  const jobs = (data?.["jobs"] as Record<string, unknown>[] | undefined) ?? [];
  return jobs.map((j) => jobFromDict(j));
}

/**
 * Looks up a job by name. First confirms existence via `/job/<name>/api/json`, then fetches
 * full detail from the list endpoint. Returns a minimal DTO if the job exists but isn't in
 * the list (e.g. inside a folder), or `null` on 404.
 */
export async function getJob(client: CloudBeesClient, name: string): Promise<JobDTO | null> {
  try {
    // Try direct endpoint first to confirm existence
    let directData: Record<string, unknown> | null = null;
    try {
      directData = await client.get<Record<string, unknown>>(
        `/job/${name}/api/json?tree=name,url`,
        { cacheKey: `jobs.exists.${name}` },
      );
    } catch (e) {
      if (String(e).includes("404")) return null;
      // fall through to list approach
    }

    // Get full detail from list
    const allJobs = await listJobs(client);
    for (const job of allJobs) {
      if (job.name === name) return job;
    }

    // Found in direct but not in list — return minimal DTO
    if (directData) {
      return jobFromDict({
        _class: "",
        name: directData["name"] ?? name,
        url: directData["url"] ?? "",
        color: "unknown",
        description: "",
        buildable: true,
        lastBuild: null,
      });
    }

    return null;
  } catch (e) {
    if (String(e).includes("404")) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Trigger / Stop
// ---------------------------------------------------------------------------

export async function triggerJob(client: CloudBeesClient, name: string): Promise<void> {
  await client.post(`/job/${name}/build`, {
    body: "",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    invalidate: "jobs.",
  });
}

/** Triggers a parameterised build via `/job/<name>/buildWithParameters` (form-encoded POST). */
export async function triggerJobWithParams(
  client: CloudBeesClient,
  name: string,
  params: Record<string, string>,
): Promise<void> {
  // Build form-encoded body
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  await client.post(`/job/${name}/buildWithParameters`, {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    invalidate: "jobs.",
  });
}

/** Sends a stop request to `/job/<jobName>/<buildNumber>/stop`. Invalidates the `jobs.` cache. */
export async function stopBuild(
  client: CloudBeesClient,
  jobName: string,
  buildNumber: number,
): Promise<void> {
  await client.post(`/job/${jobName}/${buildNumber}/stop`, { invalidate: "jobs." });
}

// ---------------------------------------------------------------------------
// Build detail / log
// ---------------------------------------------------------------------------

/** Fetches full build metadata from `/job/<jobName>/<buildNumber>/api/json` and maps it to a `BuildDTO`. */
export async function getBuildDetail(
  client: CloudBeesClient,
  jobName: string,
  buildNumber: number,
): Promise<BuildDTO> {
  const data = await client.get<Record<string, unknown>>(
    `/job/${jobName}/${buildNumber}/api/json`,
  );
  return buildFromDict((data as Record<string, unknown>) ?? {});
}

/**
 * Returns the most recent build number from `lastBuild[number]`. Falls back to the
 * `builds[]` array on a 400 (some Jenkins versions omit `lastBuild`). Returns `null`
 * when no builds exist.
 */
export async function getLastBuildNumber(
  client: CloudBeesClient,
  jobName: string,
): Promise<number | null> {
  try {
    const data = await client.get<Record<string, unknown>>(
      `/job/${jobName}/api/json?tree=lastBuild[number]`,
      { cacheKey: `jobs.lastbuild.${jobName}` },
    );
    const lb = data?.["lastBuild"] as Record<string, unknown> | null | undefined;
    if (lb && lb["number"] != null) return Number(lb["number"]);
    return null;
  } catch (e) {
    const msg = String(e);
    if (msg.includes("404")) throw e;
    if (msg.includes("400")) {
      // Fallback: check builds array
      try {
        const buildsData = await client.get<Record<string, unknown>>(
          `/job/${jobName}/api/json?tree=builds[number]`,
          { cacheKey: `jobs.builds.${jobName}` },
        );
        const builds = buildsData?.["builds"] as Record<string, unknown>[] | undefined;
        if (builds && builds.length > 0 && builds[0]["number"] != null) {
          return Number(builds[0]["number"]);
        }
        return null;
      } catch {
        throw e;
      }
    }
    throw e;
  }
}

/** Fetches the full console log for a specific build from `/job/<jobName>/<buildNumber>/consoleText`. */
export async function getBuildLog(
  client: CloudBeesClient,
  jobName: string,
  buildNumber: number,
): Promise<string> {
  return client.getText(`/job/${jobName}/${buildNumber}/consoleText`);
}

/** Resolves the latest build number then returns its full console log. Returns `"(No builds found)"` if the job has never run. */
export async function getLastBuildLog(
  client: CloudBeesClient,
  jobName: string,
): Promise<string> {
  const buildNum = await getLastBuildNumber(client, jobName);
  if (buildNum == null) return "(No builds found)";
  return getBuildLog(client, jobName, buildNum);
}

/**
 * Progressive log fetch for a specific build via `X-Text-Size` / `X-More-Data` headers.
 * @param start Byte offset to resume from (pass the previous `newOffset` on subsequent calls).
 * @returns `[text, newOffset, hasMore]` — keep calling while `hasMore` is true.
 */
export async function streamBuildLog(
  client: CloudBeesClient,
  jobName: string,
  buildNum: number,
  start = 0,
): Promise<[string, number, boolean]> {
  return client.getProgressiveText(
    `/job/${jobName}/${buildNum}/logText/progressiveText`,
    start,
  );
}

/**
 * Progressive log fetch for the most recent build. Resolves the build number first;
 * returns `["", start, false]` when no builds exist.
 * @param start Byte offset to resume from.
 * @returns `[text, newOffset, hasMore]`
 */
export async function streamLastBuildLog(
  client: CloudBeesClient,
  jobName: string,
  start = 0,
): Promise<[string, number, boolean]> {
  const buildNum = await getLastBuildNumber(client, jobName);
  if (buildNum == null) return ["", start, false];
  return streamBuildLog(client, jobName, buildNum, start);
}

/**
 * Returns the most recent `count` builds from `builds[]{0,count}` (newest-first).
 * Includes `number`, `result`, `building`, `duration`, `timestamp`, and `url`.
 */
export async function getBuildHistory(
  client: CloudBeesClient,
  jobName: string,
  count = 10,
): Promise<BuildDTO[]> {
  const data = await client.get<Record<string, unknown>>(
    `/job/${jobName}/api/json?tree=builds[number,result,building,duration,timestamp,url]{0,${count}}`,
  );
  const builds = (data?.["builds"] as Record<string, unknown>[] | undefined) ?? [];
  return builds.map((b) => buildFromDict(b));
}

/**
 * Polls `getBuildDetail` every `pollInterval` seconds until `build.building` is false
 * or `timeout` seconds elapse. Returns the final build state regardless of timeout.
 */
export async function waitForBuild(
  client: CloudBeesClient,
  jobName: string,
  buildNumber: number,
  timeout = 120,
  pollInterval = 5,
): Promise<BuildDTO> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const build = await getBuildDetail(client, jobName, buildNumber);
    if (!build.building) return build;
    await Bun.sleep(pollInterval * 1000);
  }
  return getBuildDetail(client, jobName, buildNumber);
}

// ---------------------------------------------------------------------------
// Create / Copy / Delete
// ---------------------------------------------------------------------------

/**
 * Creates a Freestyle project via `/createItem` with a full `config.xml` built by
 * `buildFreestyleXml`. Email filter keywords/regex are encoded into the presend script
 * and require a non-empty `email` recipient.
 */
export async function createFreestyleJob(
  client: CloudBeesClient,
  name: string,
  desc = "",
  shellCmd = "echo hello",
  chdir: string | null = null,
  node: string | null = null,
  schedule: string | null = null,
  email: string | null = null,
  emailCond = "failed",
  emailKeywords: string[] | null = null,
  emailRegex: string | null = null,
  params: StringParamDef[] | null = null,
): Promise<void> {
  const keywords = normalizeKeywords(emailKeywords);
  const regex = normalizeRegex(emailRegex);
  validateRegex(regex);
  if ((keywords.length > 0 || regex) && !(email && email.trim())) {
    throw new Error("Email filters require recipient email. Provide --email.");
  }
  const xml = buildFreestyleXml({
    desc,
    shellCmd,
    chdir,
    node,
    schedule,
    email,
    emailCond,
    emailKeywords: keywords,
    emailRegex: regex,
    params: params ?? undefined,
  });
  await client.postXml(`/createItem?name=${encodeURIComponent(name)}`, xml, {
    invalidate: "jobs.",
  });
}

/** Creates a CloudBees/Jenkins Folder via `/createItem` using the `com.cloudbees.hudson.plugins.folder.Folder` class XML. */
export async function createFolder(
  client: CloudBeesClient,
  name: string,
  desc = "",
): Promise<void> {
  const xml = buildFolderXml(desc);
  await client.postXml(`/createItem?name=${encodeURIComponent(name)}`, xml, {
    invalidate: "jobs.",
  });
}

/** Copies a job by reading the source `config.xml` and posting it verbatim to `/createItem?name=<destName>`. */
export async function copyJob(
  client: CloudBeesClient,
  srcName: string,
  destName: string,
): Promise<void> {
  const xmlStr = await client.getText(`/job/${srcName}/config.xml`);
  await client.postXml(`/createItem?name=${encodeURIComponent(destName)}`, xmlStr, {
    invalidate: "jobs.",
  });
}

export async function deleteJob(client: CloudBeesClient, name: string): Promise<void> {
  try {
    await client.post(`/job/${name}/doDelete`);
  } catch (e) {
    if (String(e).includes("404")) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Config summary (read config.xml and extract schedule + email info)
// ---------------------------------------------------------------------------

/**
 * Parses a job's `config.xml` and extracts the human-readable config summary:
 * cron schedule, email recipient, send condition (`failed`/`success`/`always`),
 * and anti-spam filter keywords/regex decoded from the ExtendedEmailPublisher presend script.
 * Returns `-` for any field not present in the config.
 */
export async function getJobConfigSummary(
  client: CloudBeesClient,
  name: string,
): Promise<JobConfigSummary> {
  const summary: JobConfigSummary = {
    schedule: "-",
    email: "-",
    email_cond: "-",
    email_keywords: "-",
    email_regex: "-",
    description: "",
    shell_cmd: "",
    chdir: "",
    node: "",
    params: [],
  };

  try {
    const xmlStr = await client.getText(`/job/${name}/config.xml`);
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
    const doc = parser.parse(xmlStr) as Record<string, unknown>;
    const project = doc["project"] as Record<string, unknown> | undefined;
    if (!project) return summary;

    // 1. Schedule
    const triggers = project["triggers"] as Record<string, unknown> | undefined;
    if (triggers) {
      const timer = triggers["hudson.triggers.TimerTrigger"] as
        | Record<string, unknown>
        | undefined;
      if (timer) {
        const spec = timer["spec"];
        if (typeof spec === "string" && spec.trim()) {
          summary.schedule = spec.trim();
        }
      }
    }

    // 2. Email publisher
    const publishers = project["publishers"] as Record<string, unknown> | undefined;
    if (publishers) {
      const extMail = publishers[
        "hudson.plugins.emailext.ExtendedEmailPublisher"
      ] as Record<string, unknown> | undefined;

      if (extMail) {
        const rl = extMail["recipientList"];
        if (typeof rl === "string" && rl.trim()) {
          summary.email = rl.trim();
        }

        // Infer email condition from triggers
        const configuredTriggers = extMail["configuredTriggers"] as
          | Record<string, unknown>
          | undefined;
        if (configuredTriggers) {
          const hasFailure = Boolean(
            configuredTriggers["hudson.plugins.emailext.plugins.trigger.FailureTrigger"],
          );
          const hasSuccess = Boolean(
            configuredTriggers["hudson.plugins.emailext.plugins.trigger.SuccessTrigger"],
          );
          if (hasFailure && hasSuccess) summary.email_cond = "always";
          else if (hasSuccess) summary.email_cond = "success";
          else summary.email_cond = "failed";
        }

        // Presend script / filter metadata
        const presendScript = extMail["presendScript"];
        if (typeof presendScript === "string") {
          const meta = parseEmailFilterMetadata(presendScript);
          if (meta) {
            const kws = normalizeKeywords(meta.keywords);
            const rx = normalizeRegex(meta.regex);
            if (kws.length > 0) summary.email_keywords = kws.join(", ");
            if (rx) summary.email_regex = rx;
          }
        }
      } else {
        // Built-in Mailer fallback
        const mailer = publishers["hudson.tasks.Mailer"] as
          | Record<string, unknown>
          | undefined;
        if (mailer) {
          const rec = mailer["recipients"];
          if (typeof rec === "string" && rec.trim()) {
            summary.email = rec.trim() + " (Built-in Mailer)";
          }
        }
      }
    }

    // 3. Description
    const desc = project["description"];
    if (typeof desc === "string" && desc.trim()) summary.description = desc.trim();

    // 4. Assigned node (empty when the job can roam)
    const assigned = project["assignedNode"];
    if (typeof assigned === "string" && assigned.trim()) summary.node = assigned.trim();

    // 5. Shell command (first hudson.tasks.Shell builder). Split a leading
    //    `cd <dir> && <rest>` back into chdir + shell_cmd so the edit form shows
    //    the same two fields the create form used.
    const builders = project["builders"] as Record<string, unknown> | undefined;
    if (builders) {
      let shell = builders["hudson.tasks.Shell"] as Record<string, unknown> | undefined;
      // Multiple shell builders parse as an array — take the first.
      if (Array.isArray(shell)) shell = shell[0] as Record<string, unknown> | undefined;
      const cmd = shell?.["command"];
      if (typeof cmd === "string" && cmd.length > 0) {
        const m = cmd.match(/^cd\s+(.+?)\s+&&\s+([\s\S]*)$/);
        if (m) {
          summary.chdir = m[1]!.trim();
          summary.shell_cmd = m[2]!;
        } else {
          summary.shell_cmd = cmd;
        }
      }
    }

    // 6. Build parameters (hudson.model.ParametersDefinitionProperty)
    const properties = project["properties"] as Record<string, unknown> | undefined;
    if (properties) {
      const paramsProp = properties["hudson.model.ParametersDefinitionProperty"] as
        | Record<string, unknown>
        | undefined;
      if (paramsProp) {
        const defs = paramsProp["parameterDefinitions"] as Record<string, unknown> | undefined;
        if (defs) {
          const raw = defs["hudson.model.StringParameterDefinition"];
          const items: Array<Record<string, unknown>> = Array.isArray(raw)
            ? (raw as Array<Record<string, unknown>>)
            : raw
            ? [raw as Record<string, unknown>]
            : [];
          summary.params = items
            .map((d) => ({
              name: typeof d["name"] === "string" ? d["name"] : "",
              defaultValue: typeof d["defaultValue"] === "string" ? d["defaultValue"] : "",
              description: typeof d["description"] === "string" ? d["description"] : undefined,
            }))
            .filter((d) => d.name.length > 0);
        }
      }
    }
  } catch {
    // Silently return partial summary on any error
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Update freestyle job (partial update via config.xml patch)
// ---------------------------------------------------------------------------

/**
 * Patch a freestyle job's config.xml in-place via string manipulation.
 * We re-build the relevant sections rather than using a full XML DOM library,
 * mirroring the Python approach of reading with ET, modifying, and re-posting.
 */
export async function updateJobFreestyle(
  client: CloudBeesClient,
  name: string,
  desc?: string | null,
  shellCmd?: string | null,
  node?: string | null,
  schedule?: string | null,
  email?: string | null,
  emailCond?: string | null,
  emailKeywords?: string[] | null,
  emailRegex?: string | null,
  clearEmailKeywords = false,
  clearEmailRegex = false,
  params?: StringParamDef[] | null,
  clearParams = false,
): Promise<void> {
  const xmlStr = await client.getText(`/job/${name}/config.xml`);

  // Partial update via string-level replacement, reading existing values inline.
  let updated = xmlStr;

  // Helper: replace or insert a simple text element inside a parent tag
  function replaceTextElement(xml: string, tag: string, newValue: string): string {
    const re = new RegExp(`(<${tag}>)[^<]*(</\\s*${tag}>)`, "s");
    if (re.test(xml)) {
      return xml.replace(re, `$1${escapeXml(newValue)}$2`);
    }
    // Insert before closing </project>
    return xml.replace("</project>", `  <${tag}>${escapeXml(newValue)}</${tag}>\n</project>`);
  }

  // 1. description
  if (desc != null) {
    updated = replaceTextElement(updated, "description", desc);
  }

  // 2. node / canRoam
  if (node != null) {
    if (/<assignedNode>/.test(updated)) {
      updated = updated.replace(
        /(<assignedNode>)[^<]*(<\/\s*assignedNode>)/s,
        `$1${escapeXml(node)}$2`,
      );
    } else {
      updated = updated.replace(
        "</project>",
        `  <assignedNode>${escapeXml(node)}</assignedNode>\n</project>`,
      );
    }
    const canRoamVal = node ? "false" : "true";
    if (/<canRoam>/.test(updated)) {
      updated = updated.replace(
        /(<canRoam>)[^<]*(<\/\s*canRoam>)/s,
        `$1${canRoamVal}$2`,
      );
    } else {
      updated = updated.replace(
        "</project>",
        `  <canRoam>${canRoamVal}</canRoam>\n</project>`,
      );
    }
  }

  // 3. shell command
  if (shellCmd != null) {
    if (/<command>/.test(updated)) {
      updated = updated.replace(
        /(<command>)[^<]*(<\/\s*command>)/s,
        `$1${escapeXml(shellCmd)}$2`,
      );
    } else {
      // No builders section? Inject one
      updated = updated.replace(
        "</project>",
        `  <builders>\n    <hudson.tasks.Shell>\n      <command>${escapeXml(shellCmd)}</command>\n    </hudson.tasks.Shell>\n  </builders>\n</project>`,
      );
    }
  }

  // 4. schedule (triggers)
  if (schedule != null) {
    // Remove existing TimerTrigger block
    updated = updated.replace(
      /<hudson\.triggers\.TimerTrigger>[\s\S]*?<\/hudson\.triggers\.TimerTrigger>/g,
      "",
    );
    if (schedule) {
      const timerBlock = buildTimerTriggerBlock(schedule, "    ");
      if (/<triggers>/.test(updated)) {
        updated = updated.replace(/(<triggers>)/, `$1\n${timerBlock}`);
      } else {
        updated = updated.replace(
          "</project>",
          `  <triggers>\n${timerBlock}\n  </triggers>\n</project>`,
        );
      }
    }
  }

  // 5. Email publisher
  const shouldUpdateEmail =
    email != null ||
    emailCond != null ||
    emailKeywords != null ||
    emailRegex != null ||
    clearEmailKeywords ||
    clearEmailRegex;

  if (shouldUpdateEmail) {
    // Extract current values from existing config using extractPresendScriptFromXml
    const currentPresend = extractPresendScriptFromXml(updated);
    const currentMeta = parseEmailFilterMetadata(currentPresend);
    const currentKeywords = normalizeKeywords(currentMeta?.keywords);
    const currentRegex = normalizeRegex(currentMeta?.regex);

    // Extract current email recipient from XML. Scope the search to the
    // ExtendedEmailPublisher block so we read its top-level <recipientList>
    // (the actual recipient) and never an empty <recipientList></recipientList>
    // nested inside a trigger's <email>, regardless of element ordering.
    const publisherForEmail = updated.match(
      /<hudson\.plugins\.emailext\.ExtendedEmailPublisher[\s\S]*?<\/hudson\.plugins\.emailext\.ExtendedEmailPublisher>/,
    );
    const emailSearchScope = publisherForEmail ? publisherForEmail[0] : updated;
    const emailMatch = emailSearchScope.match(/<recipientList>([^<]*)<\/recipientList>/);
    const currentEmail = emailMatch ? emailMatch[1]!.trim() : "";

    // Infer current condition from existing triggers
    const hasFailureTrigger =
      /hudson\.plugins\.emailext\.plugins\.trigger\.FailureTrigger/.test(updated);
    const hasSuccessTrigger =
      /hudson\.plugins\.emailext\.plugins\.trigger\.SuccessTrigger/.test(updated);
    let currentCond = "failed";
    if (hasFailureTrigger && hasSuccessTrigger) currentCond = "always";
    else if (hasSuccessTrigger) currentCond = "success";

    const requestedKeywords =
      emailKeywords != null ? normalizeKeywords(emailKeywords) : null;
    const requestedRegex = emailRegex != null ? normalizeRegex(emailRegex) : null;
    validateRegex(requestedRegex);

    const hasNewFilterValues = Boolean(
      (requestedKeywords && requestedKeywords.length > 0) || requestedRegex,
    );

    const targetEmail = email != null ? email.trim() : currentEmail;

    // Remove all existing ExtendedEmailPublisher blocks
    updated = updated.replace(
      /<hudson\.plugins\.emailext\.ExtendedEmailPublisher[\s\S]*?<\/hudson\.plugins\.emailext\.ExtendedEmailPublisher>/g,
      "",
    );

    if (email != null && targetEmail === "") {
      // Removing email
      if (hasNewFilterValues) {
        throw new Error("Cannot set email filters when removing recipient email.");
      }
      // Publisher already removed above
    } else if (targetEmail) {
      const targetCond = emailCond || currentCond;

      let targetKeywords = [...currentKeywords];
      let targetRegex: string | null = currentRegex;

      if (clearEmailKeywords) targetKeywords = [];
      if (clearEmailRegex) targetRegex = null;
      if (requestedKeywords != null) targetKeywords = requestedKeywords;
      if (emailRegex != null) targetRegex = requestedRegex;

      validateRegex(targetRegex);

      if ((targetKeywords.length > 0 || targetRegex) && !targetEmail) {
        throw new Error("Email filters require recipient email. Provide --email.");
      }

      const publisherBlock = buildEmailPublisherBlock(
        targetEmail,
        targetCond,
        targetKeywords,
        targetRegex,
        "    ",
      );

      // Insert inside <publishers> or create publishers section
      if (/<publishers>/.test(updated)) {
        updated = updated.replace(/(<publishers>)/, `$1\n${publisherBlock}`);
      } else {
        updated = updated.replace(
          "</project>",
          `  <publishers>\n${publisherBlock}\n  </publishers>\n</project>`,
        );
      }
    } else {
      // No target email and no existing email
      if (hasNewFilterValues) {
        throw new Error("Email filters require recipient email. Provide --email.");
      }
      if (emailCond != null) {
        throw new Error("Email condition requires recipient email. Provide --email.");
      }
    }
  }

  // 6. String parameters — swap the <properties> block. `clearParams` removes
  // them (back to <properties/>); a non-empty `params` replaces them.
  if (clearParams || (params != null && params.length > 0)) {
    const block = clearParams
      ? "  <properties/>"
      : buildParametersProperty(params ?? [], "  ");
    if (/<properties\s*\/>/.test(updated)) {
      updated = updated.replace(/<properties\s*\/>/, block.trimStart());
    } else if (/<properties>/.test(updated)) {
      updated = updated.replace(
        /<properties>[\s\S]*?<\/properties>/,
        block.trimStart(),
      );
    } else {
      updated = updated.replace(
        "</project>",
        `${block}\n</project>`,
      );
    }
  }

  await client.postXml(`/job/${name}/config.xml`, updated, { invalidate: "jobs." });
}
