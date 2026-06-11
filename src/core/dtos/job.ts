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

/** Subset of job config fields returned by the job config API, used for update flows. */
export interface JobConfigDTO {
  name: string;
  jobType: string;
  description: string;
}

/** Map a Jenkins _class string to a short job-type code. */
function classToJobType(className: string): string {
  if (className.includes("FreeStyle") || className.toLowerCase().includes("freestyle"))
    return "FS";
  if (className.includes("WorkflowJob") || className.includes("workflow.job"))
    return "PL";
  if (className.includes("Folder") || className.toLowerCase().includes("folder"))
    return "FD";
  if (className.includes("MultiBranch"))
    return "MB";
  if (!className) return "";
  // fallback: last dot-segment, first 4 chars
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

/** Maps a raw job config response to JobConfigDTO via pick() — fields must already be camelCase. */
export function jobConfigFromDict(data: Record<string, unknown>): JobConfigDTO {
  return pick<JobConfigDTO>(data, {
    name: "",
    jobType: "",
    description: "",
  });
}
