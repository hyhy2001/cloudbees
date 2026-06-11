/**
 * Node / Agent DTOs.
 * Mirrors legacy/cb/dtos/node.py
 */

import { str, num, bool, nested } from "./base.js";

/** Shape returned by the agents list endpoint (`/computer/api/json` `computer[]` entries). */
export interface NodeDTO {
  name: string;
  displayName: string;
  offline: boolean;
  numExecutors: number;
  labels: string;
  description: string;
}

/**
 * Extended node shape from `/computer/<name>/api/json` (single-agent detail).
 * Adds `launcherType`, `remoteDir`, and `configXml` on top of NodeDTO.
 */
export interface NodeDetailDTO extends NodeDTO {
  launcherType: string;
  remoteDir: string;
  configXml: string;
}

/**
 * Maps a raw agent list entry to NodeDTO.
 * `assignedLabels[0].name` → `labels`; `displayName` falls back to `name` when blank.
 */
export function nodeFromDict(data: Record<string, unknown>): NodeDTO {
  const assignedLabels = data["assignedLabels"];
  let labels = "";
  if (Array.isArray(assignedLabels) && assignedLabels.length > 0) {
    labels = str(nested(assignedLabels[0] as Record<string, unknown>, "name"));
  }

  const displayName = str(data["displayName"]);
  return {
    name: displayName || str(data["name"]),
    displayName,
    offline: bool(data["offline"], false),
    numExecutors: num(data["numExecutors"], 1),
    labels,
    description: str(data["description"]),
  };
}

function classToLauncherType(launcherClass: string): string {
  if (launcherClass.includes("JNLP") || launcherClass.includes("Inbound"))
    return "jnlp";
  if (launcherClass.includes("SSH"))
    return "ssh";
  if (!launcherClass) return "";
  return launcherClass.split(".").at(-1)!.toLowerCase();
}

/**
 * Maps a raw single-agent detail response to NodeDetailDTO.
 * `launcher._class` → normalized `launcherType` (jnlp/ssh/…); `remoteFS` → `remoteDir`.
 */
export function nodeDetailFromDict(data: Record<string, unknown>): NodeDetailDTO {
  const base = nodeFromDict(data);
  const launcher = data["launcher"];
  const launcherClass =
    launcher !== null && launcher !== undefined && typeof launcher === "object"
      ? str((launcher as Record<string, unknown>)["_class"])
      : "";

  return {
    ...base,
    launcherType: classToLauncherType(launcherClass),
    remoteDir: str(data["remoteFS"]),
    configXml: str(data["configXml"]),
  };
}
