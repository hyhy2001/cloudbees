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
  buildEmailPublisherBlock,
  extractPresendScriptFromXml,
  parseEmailFilterMetadata,
  normalizeKeywords,
} from "./xml-builder";
import type { JobConfigSummary } from "./types";
import { XMLParser } from "fast-xml-parser";

const _JOB_TREE = "jobs[_class,name,url,color,description,buildable,lastBuild[number,result,url]]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRegex(emailRegex: string | null | undefined): string | null {
  if (emailRegex == null) return null;
  const val = String(emailRegex).trim();
  return val || null;
}

function validateRegex(emailRegex: string | null | undefined): void {
  if (!emailRegex) return;
  try {
    new RegExp(emailRegex);
  } catch (e) {
    throw new Error(`Invalid --email-regex: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
  await client.post(`/job/${name}/build`, { invalidate: "jobs." });
}

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

export async function getBuildLog(
  client: CloudBeesClient,
  jobName: string,
  buildNumber: number,
): Promise<string> {
  return client.getText(`/job/${jobName}/${buildNumber}/consoleText`);
}

export async function getLastBuildLog(
  client: CloudBeesClient,
  jobName: string,
): Promise<string> {
  const buildNum = await getLastBuildNumber(client, jobName);
  if (buildNum == null) return "(No builds found)";
  return getBuildLog(client, jobName, buildNum);
}

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

export async function streamLastBuildLog(
  client: CloudBeesClient,
  jobName: string,
  start = 0,
): Promise<[string, number, boolean]> {
  const buildNum = await getLastBuildNumber(client, jobName);
  if (buildNum == null) return ["", start, false];
  return streamBuildLog(client, jobName, buildNum, start);
}

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
  });
  await client.postXml(`/createItem?name=${encodeURIComponent(name)}`, xml, {
    invalidate: "jobs.",
  });
}

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

  function escapeXml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
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
      const timerBlock = `    <hudson.triggers.TimerTrigger>\n      <spec>${escapeXml(schedule)}</spec>\n    </hudson.triggers.TimerTrigger>`;
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

    // Extract current email recipient from XML
    const emailMatch = updated.match(/<recipientList>([^<]*)<\/recipientList>/);
    const currentEmail = emailMatch ? emailMatch[1].trim() : "";

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

  await client.postXml(`/job/${name}/config.xml`, updated, { invalidate: "jobs." });
}
