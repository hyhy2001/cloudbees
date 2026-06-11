/**
 * Mine/All scope persistence — remembers each tab's filter across sessions.
 *
 * The TUI tabs (jobs/nodes/credentials) each have a Mine/All toggle (`a`). Users
 * asked for the choice to stick so they don't have to press `a` every launch.
 * We store one boolean per resource type in the settings table:
 *   scope.showall.<resourceType> = "1" | "0"
 *
 * Defaults to true (All) when unset — matches the previous in-memory default.
 */

import { getSetting, setSetting } from "./settings-repo";

function scopeKey(resourceType: string): string {
  return `scope.showall.${resourceType}`;
}

/** Read the persisted "show all" flag for a resource type (default true = All). */
export function getScopeShowAll(resourceType: string, dbPath?: string): boolean {
  const v = getSetting(scopeKey(resourceType), dbPath);
  if (v === null) return true;
  return v === "1";
}

/** Persist the "show all" flag for a resource type. */
export function setScopeShowAll(resourceType: string, showAll: boolean, dbPath?: string): void {
  setSetting(scopeKey(resourceType), showAll ? "1" : "0", dbPath);
}
