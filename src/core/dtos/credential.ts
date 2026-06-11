/**
 * Credential DTOs.
 * Mirrors legacy/cb/dtos/credential.py
 */

import { str } from "./base.js";

/** Shape returned by a credential store's `credentials[]` entries. */
export interface CredentialDTO {
  id: string;
  displayName: string;
  typeName: string;
  scope: string;
  description: string;
}

/** Maps a raw credential API entry to CredentialDTO; `scope` defaults to `"GLOBAL"` when blank. */
export function credentialFromDict(data: Record<string, unknown>): CredentialDTO {
  return {
    id: str(data["id"]),
    displayName: str(data["displayName"]),
    typeName: str(data["typeName"]),
    scope: str(data["scope"]) || "GLOBAL",
    description: str(data["description"]),
  };
}
