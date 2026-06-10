/**
 * Credential DTOs.
 * Mirrors legacy/cb/dtos/credential.py
 */

import { str } from "./base.js";

export interface CredentialDTO {
  id: string;
  displayName: string;
  typeName: string;
  scope: string;
  description: string;
}

export function credentialFromDict(data: Record<string, unknown>): CredentialDTO {
  return {
    id: str(data["id"]),
    displayName: str(data["displayName"]),
    typeName: str(data["typeName"]),
    scope: str(data["scope"]) || "GLOBAL",
    description: str(data["description"]),
  };
}
