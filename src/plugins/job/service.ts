/**
 * Job service — list, get, create (Freestyle/Folder), run, stop, log, status, update.
 * Ports legacy/cb/services/job_service.py
 */

import type { CloudBeesClient } from "../../core/api/types";
import { NotFoundError, APIError, ValidationError } from "../../core/api/errors";
import { jobFromDict, buildFromDict, queueItemFromDict } from "../../core/dtos/index";
import type { JobDTO, BuildDTO, QueueItemDTO } from "../../core/dtos/index";
import {
  buildFreestyleXml,
  buildFolderXml,
  buildPipelineXml,
  buildParametersProperty,
} from "./xml-builder";
import {
  buildEmailPublisherBlock,
  parseEmailFilterMetadata,
  normalizeKeywords,
  normalizeRegex,
  validateRegex,
} from "../../domain/email";
import { escapeXml, xmlParser } from "../../domain/xml";
import { buildTimerTriggerBlock } from "../../domain/schedule";
import type { JobConfigSummary, UpdateFreestyleOpts, CreateFreestyleOpts, CreatePipelineOpts, UpdatePipelineOpts } from "./types";
import { injectAgent, parseParametersFromScript } from "../../domain/pipeline-parse";

const _JOB_TREE = "jobs[_class,name,url,color,description,buildable,lastBuild[number,result,url]]";

/**
 * How many jobs to fetch per page. Jenkins tree syntax `{start,end}` is used
 * for range queries. 200 is a sweet spot: small enough to keep individual
 * responses under ~60 KB, large enough to cover most instances in 1–2 pages.
 */
const LIST_PAGE_SIZE = 200;

/**
 * Recursively list jobs, descending into folders.
 * Returns flat list with names like "folder/subfolder/job".
 *
 * Each folder level is paginated (LIST_PAGE_SIZE items per request) so large
 * folders don't return a single massive JSON payload. Sibling folder descents
 * at each level run in parallel via Promise.all.
 */
export async function listJobsRecursive(client: CloudBeesClient): Promise<JobDTO[]> {
  async function fetchLevel(urlPath: string, prefix: string): Promise<JobDTO[]> {
    const dtos: JobDTO[] = [];
    const folderTasks: Promise<JobDTO[]>[] = [];
    let start = 0;

    // Paginate within this folder level — same approach as listJobs().
    while (true) {
      const end = start + LIST_PAGE_SIZE;
      const endpoint = `${urlPath}/api/json?tree=${_JOB_TREE}{${start},${end}}`;
      // Include start offset in cache key to distinguish pages of the same folder.
      const cacheKey = `jobs.list.recursive.${client.baseUrl}.${urlPath}.${start}`;
      const data = await client.get<Record<string, unknown>>(endpoint, { cacheKey });
      const page = (data?.["jobs"] as Record<string, unknown>[] | undefined) ?? [];

      for (const j of page) {
        const dto = jobFromDict(j);
        const qualifiedName = prefix ? `${prefix}/${dto.name}` : dto.name;
        dto.name = qualifiedName;
        dtos.push(dto);

        // Collect folder descent tasks — siblings run in parallel after all pages.
        const cls = String((j as Record<string, unknown>)["_class"] ?? "");
        if (cls.toLowerCase().includes("folder")) {
          const folderPath = `/job/${jobPathSegments(qualifiedName)}`;
          folderTasks.push(
            fetchLevel(folderPath, qualifiedName).catch(() => [] as JobDTO[]),
          );
        }
      }

      if (page.length < LIST_PAGE_SIZE) break; // last page
      start = end;
    }

    // Descend into all discovered folders in parallel.
    const childArrays = await Promise.all(folderTasks);
    for (const children of childArrays) dtos.push(...children);
    return dtos;
  }
  return fetchLevel("", "");
}

/**
 * Convert a job name (possibly a folder path like "folder/subfolder/job") into
 * the Jenkins REST path segment. Each slash-separated component is individually
 * URL-encoded and joined with "/job/":
 *   "my job"        → "my%20job"
 *   "a/b/c"         → "a/job/b/job/c"
 *   "a b/c d"       → "a%20b/job/c%20d"
 */
export function jobPathSegments(name: string): string {
  return name
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/job/");
}

const jobSeg = jobPathSegments;

// ---------------------------------------------------------------------------
// List / Get
// ---------------------------------------------------------------------------

/**
 * List all jobs, fetching in pages of LIST_PAGE_SIZE to avoid a single massive
 * JSON response on large instances (1000+ jobs = 300 KB+ in one shot, blocking
 * the JS thread during JSON.parse). Pages are fetched sequentially until an
 * empty page signals end-of-results.
 *
 * The first page's result is cached under `jobs.list.<baseUrl>` (matching the
 * old single-call cache key) so small instances (~200 jobs) still benefit from
 * SQLite TTL caching. Subsequent pages are not individually cached because their
 * position depends on the current total, which changes as jobs are added/removed.
 */
export async function listJobs(client: CloudBeesClient): Promise<JobDTO[]> {
  const all: JobDTO[] = [];
  let start = 0;

  while (true) {
    const end = start + LIST_PAGE_SIZE;
    const endpoint = `/api/json?tree=${_JOB_TREE}{${start},${end}}`;
    const cacheKey = start === 0 ? `jobs.list.${client.baseUrl}` : undefined;
    const data = await client.get<Record<string, unknown>>(endpoint, cacheKey ? { cacheKey } : undefined);
    const page = (data?.["jobs"] as Record<string, unknown>[] | undefined) ?? [];
    for (const j of page) all.push(jobFromDict(j));
    if (page.length < LIST_PAGE_SIZE) break; // last page
    start = end;
  }

  return all;
}

/**
 * List jobs inside a specific folder (one level deep, not recursive).
 * folderPath is the qualified name like "myFolder" or "a/b".
 * Returns jobs with names qualified as "folderPath/jobName".
 */
export async function listJobsInFolder(client: CloudBeesClient, folderPath: string): Promise<JobDTO[]> {
  const urlPath = `/job/${jobPathSegments(folderPath)}`;
  const all: JobDTO[] = [];
  let start = 0;

  while (true) {
    const end = start + LIST_PAGE_SIZE;
    const endpoint = `${urlPath}/api/json?tree=${_JOB_TREE}{${start},${end}}`;
    const cacheKey = start === 0 ? `jobs.list.${client.baseUrl}.${folderPath}` : undefined;
    const data = await client.get<Record<string, unknown>>(endpoint, cacheKey ? { cacheKey } : undefined);
    const page = (data?.["jobs"] as Record<string, unknown>[] | undefined) ?? [];
    for (const j of page) {
      const dto = jobFromDict(j);
      dto.name = `${folderPath}/${dto.name}`;
      all.push(dto);
    }
    if (page.length < LIST_PAGE_SIZE) break;
    start = end;
  }

  return all;
}

/**
 * Looks up a job by name. First confirms existence via `/job/<name>/api/json`, then fetches
 * full detail from the list endpoint. Returns a minimal DTO if the job exists but isn't in
 * the list (e.g. inside a folder), or `null` on 404.
 */
export async function getJob(client: CloudBeesClient, name: string): Promise<JobDTO | null> {
  try {
    // Try direct endpoint — if it succeeds we have all we need without
    // also fetching the full job list (which is expensive for large instances).
    try {
      const directData = await client.get<Record<string, unknown>>(
        `/job/${jobSeg(name)}/api/json?tree=_class,name,url,color,description,buildable,lastBuild[number,result,url]`,
        { cacheKey: `jobs.detail.${client.baseUrl}.${name}` },
      );
      if (directData) return jobFromDict(directData);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      // fall through to list approach on other errors
    }

    // Fallback: look up from the flat list (handles cases where the direct
    // endpoint is unavailable but the job appears in the root listing).
    const allJobs = await listJobs(client);
    for (const job of allJobs) {
      if (job.name === name) return job;
    }

    return null;
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Trigger / Stop
// ---------------------------------------------------------------------------

export async function triggerJob(client: CloudBeesClient, name: string): Promise<void> {
  await client.post(`/job/${jobSeg(name)}/build`, {
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
  await client.post(`/job/${jobSeg(name)}/buildWithParameters`, {
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
  await client.post(`/job/${jobSeg(jobName)}/${buildNumber}/stop`, { invalidate: "jobs." });
}

/**
 * Lists the build queue via `/queue/api/json`. Each item is a pending build
 * waiting for an executor; `why` carries the human-readable wait reason
 * (e.g. "Waiting for next available executor"). Returns [] on any error — the
 * queue is supplementary display data and must never break the job list.
 */
export async function listQueue(client: CloudBeesClient): Promise<QueueItemDTO[]> {
  try {
    const data = await client.get<Record<string, unknown>>(
      "/queue/api/json?tree=items[id,why,stuck,task[name,url]]",
      { cacheKey: `jobs.queue.${client.baseUrl}` },
    );
    const items = (data?.["items"] as Record<string, unknown>[] | undefined) ?? [];
    return items.map(queueItemFromDict);
  } catch {
    return [];
  }
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
    `/job/${jobSeg(jobName)}/${buildNumber}/api/json`,
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
      `/job/${jobSeg(jobName)}/api/json?tree=lastBuild[number]`,
      { cacheKey: `jobs.lastbuild.${client.baseUrl}.${jobName}` },
    );
    const lb = data?.["lastBuild"] as Record<string, unknown> | null | undefined;
    if (lb && lb["number"] != null) return Number(lb["number"]);
    return null;
  } catch (e) {
    if (e instanceof NotFoundError) throw e;
    if (e instanceof APIError && e.statusCode === 400) {
      // Fallback: check builds array
      try {
        const buildsData = await client.get<Record<string, unknown>>(
          `/job/${jobSeg(jobName)}/api/json?tree=builds[number]`,
          { cacheKey: `jobs.builds.${client.baseUrl}.${jobName}` },
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
  return client.getText(`/job/${jobSeg(jobName)}/${buildNumber}/consoleText`);
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
    `/job/${jobSeg(jobName)}/${buildNum}/logText/progressiveText`,
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
    `/job/${jobSeg(jobName)}/api/json?tree=builds[number,result,building,duration,timestamp,url]{0,${count}}`,
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
  opts: CreateFreestyleOpts = {},
  folder: string | null = null,
): Promise<void> {
  const {
    desc = "",
    shellCmd = "echo hello",
    chdir = null,
    node = null,
    schedule = null,
    email = null,
    emailCond = "failed",
    emailKeywords = null,
    emailRegex = null,
    params = null,
  } = opts;
  const keywords = normalizeKeywords(emailKeywords);
  const regex = normalizeRegex(emailRegex);
  validateRegex(regex);
  if ((keywords.length > 0 || regex) && !(email && email.trim())) {
    throw new ValidationError("Email filters require recipient email. Provide --email.");
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
  const base = folder ? `/job/${jobSeg(folder)}` : "";
  await client.postXml(`${base}/createItem?name=${encodeURIComponent(name)}`, xml, {
    invalidate: "jobs.",
  });
}

/**
 * Validate a Declarative Pipeline script using Jenkins Pipeline Validation API.
 * POST /pipeline-model-converter/validate with the script content.
 * Returns `{ valid: true }` on success, or `{ valid: false, errors: string[] }` on failure.
 */
export async function validatePipelineScript(
  client: CloudBeesClient,
  script: string,
): Promise<{ valid: true } | { valid: false; errors: string[] }> {
  try {
    const body = new URLSearchParams({ jenkinsfile: script }).toString();
    const result = await client.post<Record<string, unknown>>(
      "/pipeline-model-converter/validate",
      {
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
    if ((result as Record<string, unknown>)?.["result"] === "success") {
      return { valid: true };
    }
    const errors: string[] = [];
    const rawErrors = (result as Record<string, unknown>)?.["errors"];
    if (Array.isArray(rawErrors)) {
      for (const e of rawErrors) {
        errors.push(typeof e === "string" ? e : String((e as Record<string, unknown>)?.["message"] ?? e));
      }
    }
    return { valid: false, errors: errors.length > 0 ? errors : ["Pipeline script validation failed."] };
  } catch (err) {
    // If the validation endpoint is not available, skip validation (fail open).
    return { valid: true };
  }
}

/**
 * Creates a Pipeline (WorkflowJob) via `/createItem` with a full config.xml built by
 * `buildPipelineXml`. Auto-detects parameters from the script. Validates the script
 * via the Jenkins Pipeline Validation API before creating.
 */
export async function createPipelineJob(
  client: CloudBeesClient,
  name: string,
  opts: CreatePipelineOpts = {},
  folder: string | null = null,
): Promise<void> {
  const {
    desc = "",
    script = "",
    node = null,
    schedule = null,
    email = null,
    emailCond = "failed",
    emailKeywords = null,
    emailRegex = null,
    params = null,
  } = opts;

  if (!script) {
    throw new ValidationError("Pipeline script is required. Provide --script <file|inline>.");
  }

  // Pre-process: inject agent before parsing params (node affects script).
  const finalScript = node ? injectAgent(script, node) : script;

  // Merge auto-detected params from script with explicitly provided params.
  const detectedParams = parseParametersFromScript(finalScript);
  const mergedParams = mergePipeParams(detectedParams, params);

  // Validate script against Jenkins API.
  const validation = await validatePipelineScript(client, script);
  if (!validation.valid) {
    const errMsg = validation.errors.join("; ");
    throw new ValidationError(`Pipeline script validation failed: ${errMsg}`);
  }

  const keywords = normalizeKeywords(emailKeywords);
  const regex = normalizeRegex(emailRegex);
  validateRegex(regex);
  if ((keywords.length > 0 || regex) && !(email && email.trim())) {
    throw new ValidationError("Email filters require recipient email. Provide --email.");
  }

  const xml = buildPipelineXml({
    desc,
    script: finalScript,
    schedule,
    email,
    emailCond,
    emailKeywords: keywords,
    emailRegex: regex,
    params: mergedParams.length > 0 ? mergedParams : null,
  });

  const base = folder ? `/job/${jobSeg(folder)}` : "";
  await client.postXml(`${base}/createItem?name=${encodeURIComponent(name)}`, xml, {
    invalidate: "jobs.",
  });
}

/** Merge auto-detected params with CLI-provided params. CLI values override detected ones. */
function mergePipeParams(
  detected: import("./types").StringParamDef[],
  cli: import("./types").StringParamDef[] | null | undefined,
): import("./types").StringParamDef[] {
  if (!cli || cli.length === 0) return detected;
  const cliMap = new Map(cli.map((p) => [p.name, p]));
  const merged = detected.map((p) => cliMap.get(p.name) ?? p);
  // Add CLI-only params not in detected.
  for (const p of cli) {
    if (!merged.some((m) => m.name === p.name)) merged.push(p);
  }
  return merged;
}

/**
 * Update a Pipeline job's config.xml in-place (partial update).
 * Validates the script before applying changes.
 */
export async function updatePipelineJob(
  client: CloudBeesClient,
  name: string,
  opts: UpdatePipelineOpts = {},
): Promise<void> {
  const {
    desc,
    script,
    node,
    schedule,
    email,
    emailCond,
    emailKeywords,
    emailRegex,
    clearEmailKeywords = false,
    clearEmailRegex = false,
    params,
    clearParams = false,
  } = opts;

  const xmlStr = await client.getText(`/job/${jobSeg(name)}/config.xml`);
  const doc = xmlParser.parse(xmlStr) as Record<string, unknown>;
  const defn = doc["flow-definition"] as Record<string, unknown> | undefined;
  if (!defn) {
    throw new Error(`Job '${name}' is not a Pipeline (no <flow-definition> root).`);
  }

  const currentDef = defn["definition"] as Record<string, unknown> | undefined;
  const currentScript = typeof currentDef?.["script"] === "string"
    ? (currentDef["script"] as string)
    : "";

  // Read current values from XML.
  const currentDesc = typeof defn["description"] === "string" ? (defn["description"] as string) : "";
  const currentPublishers = defn["publishers"] as Record<string, unknown> | undefined;
  const currentExtMail = currentPublishers?.["hudson.plugins.emailext.ExtendedEmailPublisher"] as Record<string, unknown> | undefined;
  const currentEmail = typeof currentExtMail?.["recipientList"] === "string"
    ? (currentExtMail["recipientList"] as string).trim()
    : "";
  const currentPresend = typeof currentExtMail?.["presendScript"] === "string"
    ? (currentExtMail["presendScript"] as string)
    : null;
  const currentMeta = parseEmailFilterMetadata(currentPresend);
  const currentKeywords = normalizeKeywords(currentMeta?.keywords);
  const currentRegex = normalizeRegex(currentMeta?.regex);

  const targetScript = script ?? currentScript;
  const targetDesc = desc ?? currentDesc;

  // Validate new script if provided.
  if (script) {
    const validation = await validatePipelineScript(client, script);
    if (!validation.valid) {
      const errMsg = validation.errors.join("; ");
      throw new ValidationError(`Pipeline script validation failed: ${errMsg}`);
    }
  }

  // Handle node: inject/replace agent in the target script.
  let finalScript = targetScript;
  if (node != null) {
    finalScript = node ? injectAgent(finalScript, node) : targetScript;
  }

  // Merge params.
  let targetParams: import("./types").StringParamDef[] | null = null;
  if (clearParams) {
    targetParams = [];
  } else if (params != null && params.length > 0) {
    const detectedParams = parseParametersFromScript(finalScript);
    targetParams = mergePipeParams(detectedParams, params);
  }

  // Build updated XML from scratch with the merged values.
  // Strategy: rebuild the whole config.xml (simpler than patching by parts like freestyle,
  // since pipeline XML is smaller and less complex).
  const mergedCond = emailCond ?? (currentMeta ? "custom" : "failed");

  // Determine effective email values.
  let targetEmail = email != null ? email.trim() : currentEmail;
  let targetKeywords = [...currentKeywords];
  let targetRegex: string | null = currentRegex;
  if (clearEmailKeywords) targetKeywords = [];
  if (clearEmailRegex) targetRegex = null;
  if (emailKeywords != null) targetKeywords = normalizeKeywords(emailKeywords);
  if (emailRegex != null) targetRegex = normalizeRegex(emailRegex);
  validateRegex(targetRegex);

  if ((targetKeywords.length > 0 || targetRegex) && !targetEmail) {
    throw new ValidationError("Email filters require recipient email. Provide --email.");
  }

  // Schedule: read current from XML.
  const currentTriggers = defn["triggers"] as Record<string, unknown> | undefined;
  const currentTimer = currentTriggers?.["hudson.triggers.TimerTrigger"] as Record<string, unknown> | undefined;
  const currentSchedule = typeof currentTimer?.["spec"] === "string" ? (currentTimer["spec"] as string) : "";
  const targetSchedule = schedule ?? currentSchedule;

  const newXml = buildPipelineXml({
    desc: targetDesc,
    script: finalScript,
    schedule: targetSchedule || null,
    email: targetEmail || null,
    emailCond: mergedCond,
    emailKeywords: targetKeywords.length > 0 ? targetKeywords : null,
    emailRegex: targetRegex || null,
    params: targetParams,
  });

  await client.postXml(`/job/${jobSeg(name)}/config.xml`, newXml, {
    invalidate: "jobs.",
  });
}

/**
 * Fetch a Pipeline job's config.xml and extract the script content.
 * Returns null if the job is not a pipeline or has no script.
 */
export async function getPipelineScript(
  client: CloudBeesClient,
  name: string,
): Promise<string | null> {
  try {
    const xmlStr = await client.getText(`/job/${jobSeg(name)}/config.xml`);
    const doc = xmlParser.parse(xmlStr) as Record<string, unknown>;
    const flowDef = doc["flow-definition"] as Record<string, unknown> | undefined;
    if (!flowDef) return null;
    const definition = flowDef["definition"] as Record<string, unknown> | undefined;
    if (!definition) return null;
    const script = definition["script"];
    return typeof script === "string" ? script : null;
  } catch {
    return null;
  }
}

/** Creates a CloudBees/Jenkins Folder via `/createItem` using the `com.cloudbees.hudson.plugins.folder.Folder` class XML. */
export async function createFolder(
  client: CloudBeesClient,
  name: string,
  desc = "",
  folder: string | null = null,
): Promise<void> {
  const xml = buildFolderXml(desc);
  const base = folder ? `/job/${jobSeg(folder)}` : "";
  await client.postXml(`${base}/createItem?name=${encodeURIComponent(name)}`, xml, {
    invalidate: "jobs.",
  });
}

/** Copies a job by reading the source `config.xml` and posting it verbatim to `/createItem?name=<destName>`. */
export async function copyJob(
  client: CloudBeesClient,
  srcName: string,
  destName: string,
  folder: string | null = null,
): Promise<void> {
  const xmlStr = await client.getText(`/job/${jobSeg(srcName)}/config.xml`);
  const base = folder ? `/job/${jobSeg(folder)}` : "";
  await client.postXml(`${base}/createItem?name=${encodeURIComponent(destName)}`, xmlStr, {
    invalidate: "jobs.",
  });
}

/**
 * Move a job to a different folder (or to root) by copying its config.xml to
 * the destination and deleting the source. The destination job name is the
 * leaf of srcName unless destLeaf is provided. Atomic at the Jenkins level is
 * not possible, so we copy first; if delete fails the copy is rolled back.
 */
export async function moveJob(
  client: CloudBeesClient,
  srcName: string,
  destFolder: string | null,
  destLeaf?: string,
): Promise<string> {
  const srcLeaf = srcName.split("/").at(-1)!;
  const leaf = destLeaf?.trim() || srcLeaf;
  const destQualified = destFolder ? `${destFolder}/${leaf}` : leaf;

  // Copy first so the source remains intact if the post fails.
  await copyJob(client, srcName, leaf, destFolder);
  try {
    await deleteJob(client, srcName);
  } catch (err) {
    // Roll back the copy if delete fails to avoid duplicates.
    try { await deleteJob(client, destQualified); } catch { /* best-effort */ }
    throw err;
  }
  return destQualified;
}

export async function deleteJob(client: CloudBeesClient, name: string): Promise<void> {
  try {
    await client.post(`/job/${jobSeg(name)}/doDelete`);
  } catch (e) {
    if (e instanceof NotFoundError) return;
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

  const xmlStr = await client.getText(`/job/${jobSeg(name)}/config.xml`);
  let doc: Record<string, unknown>;
  try {
    doc = xmlParser.parse(xmlStr) as Record<string, unknown>;
  } catch {
    // Malformed XML — return partial summary rather than crashing.
    return summary;
  }
  const project = doc["project"] as Record<string, unknown> | undefined;
  const flowDef = doc["flow-definition"] as Record<string, unknown> | undefined;
  const root = project ?? flowDef;
  if (!root) return summary;

  function readTriggers(node: Record<string, unknown>): void {
    const triggers = node["triggers"] as Record<string, unknown> | undefined;
    if (!triggers) return;
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

  function readPublishers(node: Record<string, unknown>): void {
    const publishers = node["publishers"] as Record<string, unknown> | undefined;
    if (!publishers) return;
    const extMail = publishers[
      "hudson.plugins.emailext.ExtendedEmailPublisher"
    ] as Record<string, unknown> | undefined;

    if (extMail) {
      const rl = extMail["recipientList"];
      if (typeof rl === "string" && rl.trim()) {
        summary.email = rl.trim();
      }

      const configuredTriggers = extMail["configuredTriggers"] as
        | Record<string, unknown>
        | undefined;
      const presendScript = extMail["presendScript"];
      let _hasMeta = false;
      if (typeof presendScript === "string") {
        const meta = parseEmailFilterMetadata(presendScript);
        if (meta) {
          _hasMeta = true;
          const kws = normalizeKeywords(meta.keywords);
          const rx = normalizeRegex(meta.regex);
          if (kws.length > 0) summary.email_keywords = kws.join(", ");
          if (rx) summary.email_regex = rx;
        }
      }

      if (configuredTriggers) {
        const hasFailure = Boolean(
          configuredTriggers["hudson.plugins.emailext.plugins.trigger.FailureTrigger"],
        );
        const hasSuccess = Boolean(
          configuredTriggers["hudson.plugins.emailext.plugins.trigger.SuccessTrigger"],
        );
        if (hasFailure && hasSuccess && _hasMeta) summary.email_cond = "custom";
        else if (hasFailure && hasSuccess) summary.email_cond = "always";
        else if (hasSuccess) summary.email_cond = "success";
        else summary.email_cond = "failed";
      }
    } else {
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

  function readProperties(node: Record<string, unknown>): void {
    const properties = node["properties"] as Record<string, unknown> | undefined;
    if (!properties) return;
    const paramsProp = properties["hudson.model.ParametersDefinitionProperty"] as
      | Record<string, unknown>
      | undefined;
    if (!paramsProp) return;
    const defs = paramsProp["parameterDefinitions"] as Record<string, unknown> | undefined;
    if (!defs) return;
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

    // 1. Schedule
    readTriggers(root);

    // 2. Email publisher
    readPublishers(root);

    // 3. Description
    const desc = root["description"];
    if (typeof desc === "string" && desc.trim()) summary.description = desc.trim();

    if (project) {
      // 4. Assigned node (only for freestyle)
      const assigned = project["assignedNode"];
      if (typeof assigned === "string" && assigned.trim()) summary.node = assigned.trim();

      // 5. Shell command (only for freestyle)
      const builders = project["builders"] as Record<string, unknown> | undefined;
      if (builders) {
        let shell = builders["hudson.tasks.Shell"] as Record<string, unknown> | undefined;
        if (Array.isArray(shell)) shell = shell[0] as Record<string, unknown> | undefined;
        const cmd = shell?.["command"];
        if (typeof cmd === "string" && cmd.length > 0) {
          const m = cmd.match(/^cd\s+"(.+?)"\s+&&\s+([\s\S]*)$/) ??
            cmd.match(/^cd\s+(\S+)\s+&&\s+([\s\S]*)$/);
          if (m) {
            summary.chdir = m[1]!.trim();
            summary.shell_cmd = m[2]!;
          } else {
            summary.shell_cmd = cmd;
          }
        }
      }
    } else if (flowDef) {
      // Pipeline: extract agent from script for display.
      const definition = flowDef["definition"] as Record<string, unknown> | undefined;
      if (definition) {
        const scriptStr = typeof definition["script"] === "string" ? (definition["script"] as string) : "";
        if (scriptStr) {
          const agent = scriptStr.match(/agent\s+\{?[^}]*label\s+(['"])([^'"]+)\1/);
          if (agent) summary.node = agent[2]!;
        }
      }
    }

    // 6. Build parameters (shared between freestyle and pipeline)
    readProperties(root);

  return summary;
}

// ---------------------------------------------------------------------------
// Update freestyle job (partial update via config.xml patch)
// ---------------------------------------------------------------------------

/**
 * Patch a freestyle job's config.xml in-place.
 *
 * Strategy: hybrid DOM + string.
 *  - READ current values by parsing the XML once with XMLParser (reliable,
 *    no regex fragility around whitespace or attribute order).
 *  - WRITE changes via targeted string replacements that preserve the original
 *    Jenkins XML structure (indentation, prolog, CDATA). XMLBuilder is
 *    intentionally NOT used for serialisation — it would change the prolog
 *    version (1.1 → 1.0) and may reorder elements, both of which Jenkins
 *    would reject or mishandle.
 *
 * String helpers use a single .replace() with a flag-tracking callback to
 * avoid the two-pass test() + replace() pattern.
 */
export async function updateJobFreestyle(
  client: CloudBeesClient,
  name: string,
  opts: UpdateFreestyleOpts = {},
): Promise<void> {
  const {
    desc,
    shellCmd,
    node,
    schedule,
    email,
    emailCond,
    emailKeywords,
    emailRegex,
    clearEmailKeywords = false,
    clearEmailRegex = false,
    params,
    clearParams = false,
  } = opts;
  const xmlStr = await client.getText(`/job/${jobSeg(name)}/config.xml`);

  // Parse once here — used only to READ current values reliably (whitespace-
  // agnostic, no regex fragility). WRITING still uses targeted string
  // replacements to preserve the Jenkins XML structure (prolog version 1.1,
  // element order, CDATA blocks) that XMLBuilder would corrupt.
  const _doc = xmlParser.parse(xmlStr) as Record<string, unknown>;
  const _project = (_doc["project"] ?? {}) as Record<string, unknown>;
  const _publishers = (_project["publishers"] ?? {}) as Record<string, unknown>;
  const _extMail = _publishers[
    "hudson.plugins.emailext.ExtendedEmailPublisher"
  ] as Record<string, unknown> | undefined;

  // Current email recipient (top-level <recipientList> of the publisher).
  const _currentEmail =
    typeof _extMail?.["recipientList"] === "string"
      ? (_extMail["recipientList"] as string).trim()
      : "";

  // Current presend script + its embedded filter metadata.
  const _currentPresend =
    typeof _extMail?.["presendScript"] === "string"
      ? (_extMail["presendScript"] as string)
      : null;
  const _currentMeta = parseEmailFilterMetadata(_currentPresend);
  const _currentKeywords = normalizeKeywords(_currentMeta?.keywords);
  const _currentRegex = normalizeRegex(_currentMeta?.regex);

  // Infer current condition from trigger DOM nodes instead of regex-scanning the
  // raw string (robust against element ordering and whitespace variation).
  // "custom" = both triggers present AND a filter presend script is set.
  const _configuredTriggers = (_extMail?.["configuredTriggers"] ?? {}) as Record<string, unknown>;
  const _hasFailureTrigger = Boolean(
    _configuredTriggers["hudson.plugins.emailext.plugins.trigger.FailureTrigger"],
  );
  const _hasSuccessTrigger = Boolean(
    _configuredTriggers["hudson.plugins.emailext.plugins.trigger.SuccessTrigger"],
  );
  const _hasFilterScript = Boolean(_currentMeta);
  const _currentCond: string = _hasFailureTrigger && _hasSuccessTrigger && _hasFilterScript
    ? "custom"
    : _hasFailureTrigger && _hasSuccessTrigger
    ? "always"
    : _hasSuccessTrigger
      ? "success"
      : "failed";

  // Partial update via string-level replacement.
  let updated = xmlStr;

  // Insert `content` before the root closing tag (handles <project>, <folder>, <matrix-project>, etc.)
  function insertBeforeRootClose(xml: string, content: string): string {
    return xml.replace(/(<\/[A-Za-z][A-Za-z0-9._-]*>\s*)$/, `${content}\n$1`);
  }

  // Helper: replace or insert a simple text element.
  // Single-pass: one .replace() call with a flag-tracking callback avoids the
  // two-operation test() + replace() pattern of the previous implementation.
  function replaceOrInsertElement(xml: string, tag: string, newValue: string): string {
    let replaced = false;
    const next = xml.replace(
      new RegExp(`(<${tag}>)[^<]*(</\\s*${tag}>)`, "s"),
      (_m, open: string, close: string) => {
        replaced = true;
        return `${open}${escapeXml(newValue)}${close}`;
      },
    );
    if (replaced) return next;
    return insertBeforeRootClose(xml, `  <${tag}>${escapeXml(newValue)}</${tag}>`);
  }

  // 1. description
  if (desc != null) {
    updated = replaceOrInsertElement(updated, "description", desc);
  }

  // 2. node / canRoam
  if (node != null) {
    if (/<assignedNode>/.test(updated)) {
      updated = updated.replace(
        /(<assignedNode>)[^<]*(<\/\s*assignedNode>)/s,
        `$1${escapeXml(node)}$2`,
      );
    } else {
      updated = insertBeforeRootClose(updated, `  <assignedNode>${escapeXml(node)}</assignedNode>`);
    }
    const canRoamVal = node ? "false" : "true";
    if (/<canRoam>/.test(updated)) {
      updated = updated.replace(
        /(<canRoam>)[^<]*(<\/\s*canRoam>)/s,
        `$1${canRoamVal}$2`,
      );
    } else {
      updated = insertBeforeRootClose(updated, `  <canRoam>${canRoamVal}</canRoam>`);
    }
  }

  // 3. shell command — handle both plain text and CDATA content
  if (shellCmd != null) {
    // Match <command>...</command> with either plain text or CDATA content.
    const cmdTagRe = /(<command>)([\s\S]*?)(<\/\s*command>)/;
    const cdataTagRe = /(<command>)<!\[CDATA\[[\s\S]*?\]\]>(<\/\s*command>)/;
    if (cdataTagRe.test(updated)) {
      updated = updated.replace(cdataTagRe, `$1<![CDATA[${shellCmd}]]>$2`);
    } else if (cmdTagRe.test(updated)) {
      updated = updated.replace(cmdTagRe, `$1${escapeXml(shellCmd)}$3`);
    } else {
      // No builders section? Inject one.
      updated = insertBeforeRootClose(
        updated,
        `  <builders>\n    <hudson.tasks.Shell>\n      <command>${escapeXml(shellCmd)}</command>\n    </hudson.tasks.Shell>\n  </builders>`,
      );
    }
  }

  // 4. schedule (triggers)
  if (schedule != null) {
    const timerRe = /<hudson\.triggers\.TimerTrigger>[\s\S]*?<\/hudson\.triggers\.TimerTrigger>/;
    const hadTimer = timerRe.test(updated);
    // Remove existing timer block before re-inserting (Jenkins only supports one).
    updated = updated.replace(timerRe, "");
    if (schedule) {
      const timerBlock = buildTimerTriggerBlock(schedule, "    ");
      if (/<triggers>/.test(updated)) {
        updated = updated.replace(/(<triggers>)/, `$1\n${timerBlock}`);
      } else if (hadTimer) {
        // Timer was removed but <triggers> wrapper went with it — re-add wrapper.
        updated = insertBeforeRootClose(updated, `  <triggers>\n${timerBlock}\n  </triggers>`);
      } else {
        updated = insertBeforeRootClose(updated, `  <triggers>\n${timerBlock}\n  </triggers>`);
      }
    }
  }

  // 5. Email publisher
  // Always rebuild the publisher block when a filter script is present — this
  // migrates old presend scripts to the current version on any update, even if
  // the caller only changed desc/shell/node.
  const hasExistingEmail = Boolean(_currentEmail);
  const hasExistingFilter = Boolean(_currentMeta);
  const shouldUpdateEmail =
    email != null ||
    emailCond != null ||
    emailKeywords != null ||
    emailRegex != null ||
    clearEmailKeywords ||
    clearEmailRegex ||
    (hasExistingEmail && hasExistingFilter);

  if (shouldUpdateEmail) {
    // Use the DOM-read values computed at the top of the function (xmlParser parse).
    // These replace the three regex-based reads that were here before — the DOM
    // approach is whitespace-agnostic and element-order-independent.
    const currentKeywords = _currentKeywords;
    const currentRegex = _currentRegex;
    const currentEmail = _currentEmail;
    let currentCond = _currentCond;

    const requestedKeywords =
      emailKeywords != null ? normalizeKeywords(emailKeywords) : null;
    const requestedRegex = emailRegex != null ? normalizeRegex(emailRegex) : null;
    validateRegex(requestedRegex);

    const hasNewFilterValues = Boolean(
      (requestedKeywords && requestedKeywords.length > 0) || requestedRegex,
    );

    const targetEmail = email != null ? email.trim() : currentEmail;

    // Remove the first existing ExtendedEmailPublisher block (Jenkins only supports one).
    updated = updated.replace(
      /<hudson\.plugins\.emailext\.ExtendedEmailPublisher[\s\S]*?<\/hudson\.plugins\.emailext\.ExtendedEmailPublisher>/,
      "",
    );

    if (email != null && targetEmail === "") {
      // Removing email
      if (hasNewFilterValues) {
        throw new ValidationError("Cannot set email filters when removing recipient email.");
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
        throw new ValidationError("Email filters require recipient email. Provide --email.");
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
        updated = insertBeforeRootClose(updated, `  <publishers>\n${publisherBlock}\n  </publishers>`);
      }
    } else {
      // No target email and no existing email
      if (hasNewFilterValues) {
        throw new ValidationError("Email filters require recipient email. Provide --email.");
      }
      if (emailCond != null) {
        throw new ValidationError("Email condition requires recipient email. Provide --email.");
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
      updated = insertBeforeRootClose(updated, block);
    }
  }

  await client.postXml(`/job/${jobSeg(name)}/config.xml`, updated, { invalidate: "jobs." });
}

// ── Folders Plus controlled-agent ─────────────────────────────────────────────

export interface ControlledAgentGrant {
  /** Agent name, or null when the grant is unassigned (handshake not completed). */
  agentName: string | null;
  grantId: string;
}

/**
 * Fetch the controlled-agents list for a folder (FD type only).
 * Parses the HTML table at `/job/{folder}/controlled-slaves/`.
 * Returns [] when the folder has no controlled-agent grants or the plugin is not installed.
 */
export async function listControlledAgents(
  client: CloudBeesClient,
  folderName: string,
): Promise<ControlledAgentGrant[]> {
  const folderPath = folderName.split("/").map((s) => `job/${encodeURIComponent(s)}`).join("/");
  let html: string;
  try {
    html = await client.getText(`/${folderPath}/controlled-slaves/`);
  } catch {
    return [];
  }

  const grants: ControlledAgentGrant[] = [];

  // Each row: agent link OR "Unassigned" text, plus a delete link containing the grantId.
  // The table renders the confirmation link as `/delete` (the POST action is
  // `/doDelete` — a different endpoint).
  const rowRe = /href="(?:[^"]*\/)?grantsById\/([^/"]+)\/delete"/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const grantId = m[1]!;
    // Find the agent name: scan the 1000 chars before the delete link for the
    // last /computer/{name}/ href. Pick the last match so we get the closest one.
    const before = html.slice(Math.max(0, m.index - 1000), m.index);
    const agentRe = /href="[^"]*\/computer\/([^/"]+)\/"/g;
    let agentMatch: RegExpExecArray | null;
    let lastAgentMatch: RegExpExecArray | null = null;
    while ((agentMatch = agentRe.exec(before)) !== null) lastAgentMatch = agentMatch;
    const agentName = lastAgentMatch
      ? decodeURIComponent(lastAgentMatch[1]!.replace(/\+/g, " "))
      : null;
    grants.push({ agentName, grantId });
  }

  return grants;
}

/**
 * Approve an agent for a folder (full 5-step Folders Plus handshake).
 * Delegates to the node service functions — kept here so job commands
 * can import a single entry point.
 */
export async function approveAgentForFolder(
  client: CloudBeesClient,
  folderName: string,
  agentName: string,
): Promise<void> {
  const { approveFolder } = await import("../node/service");
  await approveFolder(client, agentName, folderName);
}

/**
 * Remove a controlled-agent grant from a folder by agent name.
 * Looks up the grantId from `listControlledAgents`, then deletes it.
 * Throws if no grant is found for the given agent name.
 */
export async function removeAgentFromFolder(
  client: CloudBeesClient,
  folderName: string,
  agentName: string,
): Promise<void> {
  const grants = await listControlledAgents(client, folderName);
  const grant = grants.find(
    (g) => g.agentName?.toLowerCase() === agentName.toLowerCase(),
  );
  if (!grant) {
    throw new Error(`No approved grant found for agent '${agentName}' in folder '${folderName}'.`);
  }
  await removeControlledAgentGrant(client, folderName, grant.grantId);
}

/**
 * Remove a controlled-agent grant from a folder by grant ID (low-level).
 * `grantId` comes from `listControlledAgents`.
 */
export async function removeControlledAgentGrant(
  client: CloudBeesClient,
  folderName: string,
  grantId: string,
): Promise<void> {
  const folderPath = folderName.split("/").map((s) => `job/${encodeURIComponent(s)}`).join("/");
  await client.post(
    `/${folderPath}/controlled-slaves/grantsById/${encodeURIComponent(grantId)}/doDelete`,
    { body: "Submit=Yes", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
}
