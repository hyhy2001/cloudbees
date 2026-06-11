/**
 * Auth / profile DTOs (local DB, not from API).
 * Mirrors legacy/cb/dtos/auth.py
 */

import { pick } from "./base.js";

/** A saved login profile (server URL + username), persisted in the local `profiles` table — not an API shape. */
export interface ProfileDTO {
  id: number;
  name: string;
  serverUrl: string;
  username: string;
  isDefault: boolean;
  createdAt: number;
}

/**
 * Construct a ProfileDTO from a raw dict.
 * Uses pick() to filter unknown keys and apply defaults — mirrors Python BaseDTO.from_dict.
 * Note: Python uses snake_case field names from a local DB row, so we accept both
 * camelCase and snake_case keys here for robustness.
 */
export function fromDict(data: Record<string, unknown>): ProfileDTO {
  // Normalise snake_case DB columns → camelCase for pick()
  const normalised: Record<string, unknown> = { ...data };
  if (normalised["server_url"] !== undefined && normalised["serverUrl"] === undefined)
    normalised["serverUrl"] = normalised["server_url"];
  if (normalised["is_default"] !== undefined && normalised["isDefault"] === undefined)
    normalised["isDefault"] = normalised["is_default"];
  if (normalised["created_at"] !== undefined && normalised["createdAt"] === undefined)
    normalised["createdAt"] = normalised["created_at"];

  return pick<ProfileDTO>(normalised, {
    id: 0,
    name: "",
    serverUrl: "",
    username: "",
    isDefault: false,
    createdAt: 0,
  });
}
