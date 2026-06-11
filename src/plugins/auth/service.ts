/**
 * Auth service — login, logout, token utilities.
 * Ports legacy/cb/services/auth_service.py (login, logout, _build_basic_token).
 *
 * getClient() is intentionally NOT duplicated here — it lives in core/client-factory.ts
 * and is exposed via PluginContext.getClient(). Import from there if needed.
 */

import { CloudBeesClientImpl, AuthError } from "../../core/api/index";
import { saveSession, clearSession } from "../../core/session/index";
import { saveProfile } from "../../core/db/repositories/profile-repo";
import type { Profile } from "../../core/db/repositories/profile-repo";

/**
 * Build a Basic-auth token: base64(username:password).
 * Mirrors Python _build_basic_token().
 */
export function buildBasicToken(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`).toString("base64");
}

/**
 * Authenticate against CloudBees, save profile and session.
 * Throws AuthError with a user-friendly message on bad credentials.
 * Mirrors Python auth_service.login().
 */
export async function login(
  serverUrl: string,
  username: string,
  token: string,
  profileName = "default",
  isDefault = true,
  dbPath?: string,
): Promise<Profile> {
  const basicToken = buildBasicToken(username, token);
  const client = new CloudBeesClientImpl(serverUrl, basicToken);

  try {
    await client.get("/me/api/json?tree=id,fullName");
  } catch (err) {
    if (err instanceof AuthError) {
      throw new AuthError("Login failed: invalid username or password.");
    }
    throw err;
  }

  const profile = saveProfile(profileName, serverUrl, username, isDefault, dbPath);
  saveSession(basicToken, profileName, serverUrl, username, dbPath);
  return profile;
}

/**
 * Clear the active session.
 * Mirrors Python auth_service.logout().
 */
export function logout(profileName?: string, dbPath?: string): void {
  // Clear a specific profile's session, or the active one when omitted.
  clearSession(profileName, dbPath);
}

/**
 * Delete a named profile from the DB.
 * Thin re-export so commands.ts only imports from service.ts.
 */
export { deleteProfile } from "../../core/db/repositories/profile-repo";
export { listProfiles } from "../../core/db/repositories/profile-repo";
