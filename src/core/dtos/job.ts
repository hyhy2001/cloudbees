/**
 * Job-related DTOs.
 * Mirrors legacy/cb/dtos/job.py
 */

import { str, num, bool, nested, pick } from "./base.js";

/** Shape returned by `/api/json` job list entries (e.g. `jobs[]` on a folder or root). */
export interface JobDTO {
  id: string;
  name: string;
  url: string;
  color: string;
  buildable: boolean;
  lastBuildNumber: number | null;
  lastBuildUrl: string | null;
  description: string;
  jobClass: string;
  jobType: string;
}

/** Shape returned by a build entry under `/job/<name>/<n>/api/json`. */
export interface BuildDTO {
  number: number;
  result: string;
  building: boolean;
  duration: number;
  timestamp: number;
  url: string;
}

/**
 * One entry from `/queue/api/json`. A queued (pending) build sits here until an
 * executor picks it up. `why` is Jenkins' human-readable reason for the wait
 * (e.g. "Waiting for next available executor on 'agent-x'"); null once it's
 * about to run. `taskUrl` is the job's URL, used to match queue items back to
 * job-list rows.
 */
export interface QueueItemDTO {
  id: number;
  taskName: string;
  taskUrl: string;
  why: string | null;
  stuck: boolean;
}

/** Subset of job config fields returned by the job config API, used for update flows. */
export interface JobConfigDTO {
  name: string;
  jobType: string;
  description: string;
}

/**
 * Map a Jenkins `_class` string to a short job-type code.
 *
 * Uses a Map for O(1) lookup — with 1000 jobs the previous linear array scan
 * cost 7000 string comparisons per list call.
 *
 * Ordered insertion doesn't matter for Map lookups, but MB entries must still
 * be present before FD so the fallback dot-segment logic isn't needed for those.
 */
const CLASS_TO_TYPE = new Map<string, string>([
  // MultiBranch — must be distinct from Folder
  ["org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject", "MB"],
  ["com.cloudbees.hudson.plugins.folder.OrganizationFolder", "MB"],
  ["jenkins.branch.OrganizationFolder", "MB"],
  // Pipeline (Workflow)
  ["org.jenkinsci.plugins.workflow.job.WorkflowJob", "PL"],
  ["com.cloudbees.workflow.flow.CpsFlowJob", "PL"],
  // Folder
  ["com.cloudbees.hudson.plugins.folder.Folder", "FD"],
  // Freestyle
  ["hudson.model.FreeStyleProject", "FS"],
]);

function classToJobType(className: string): string {
  if (!className) return "";
  const hit = CLASS_TO_TYPE.get(className);
  if (hit) return hit;
  // Fallback: last dot-segment, first 4 chars (original case, no uppercase).
  return className.split(".").at(-1)!.slice(0, 4);
}

/**
 * Maps a raw API job entry to JobDTO.
 * `_class` → `jobClass` and is also converted to a short `jobType` code (FS/PL/FD/MB).
 * `lastBuild.number` / `lastBuild.url` are extracted from the nested `lastBuild` object;
 * null when no build has run yet.
 */
export function jobFromDict(data: Record<string, unknown>): JobDTO {
  const className = str(data["_class"]);
  const lastBuild = data["lastBuild"];
  const hasLastBuild =
    lastBuild !== null && lastBuild !== undefined && typeof lastBuild === "object";

  return {
    id: str(data["name"]),
    name: str(data["name"]),
    url: str(data["url"]),
    color: str(data["color"]),
    buildable: bool(data["buildable"], true),
    lastBuildNumber: hasLastBuild
      ? (nested(lastBuild, "number") !== undefined
          ? num(nested(lastBuild, "number"), 0)
          : null)
      : null,
    lastBuildUrl: hasLastBuild
      ? str(nested(lastBuild, "url") ?? null) || null
      : null,
    description: str(data["description"]),
    jobClass: className,
    jobType: classToJobType(className),
  };
}

/** Maps a raw build API entry to BuildDTO. `result` is coerced to `""` when null (in-progress build). */
export function buildFromDict(data: Record<string, unknown>): BuildDTO {
  return {
    number: num(data["number"], 0),
    result: data["result"] != null ? str(data["result"]) : "",
    building: bool(data["building"], false),
    duration: num(data["duration"], 0),
    timestamp: num(data["timestamp"], 0),
    url: str(data["url"]),
  };
}

/**
 * Maps a raw `/queue/api/json` item to QueueItemDTO. `task.name`/`task.url`
 * identify the job; `why` is null when the item is no longer waiting.
 */
export function queueItemFromDict(data: Record<string, unknown>): QueueItemDTO {
  const task = data["task"];
  return {
    id: num(data["id"], 0),
    taskName: str(nested(task, "name")),
    taskUrl: str(nested(task, "url")),
    why: data["why"] != null ? str(data["why"]) : null,
    stuck: bool(data["stuck"], false),
  };
}

/** Maps a raw job config response to JobConfigDTO via pick() — fields must already be camelCase. */
export function jobConfigFromDict(data: Record<string, unknown>): JobConfigDTO {
  return pick<JobConfigDTO>(data, {
    name: "",
    jobType: "",
    description: "",
  });
}
