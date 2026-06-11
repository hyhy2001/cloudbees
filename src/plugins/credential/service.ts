/**
 * Credential service — controller-scoped for CloudBees CI / OC.
 *
 * Endpoint pattern:
 *   store="system" -> /credentials/store/system/domain/_
 *   store="user"   -> /user/<username>/credentials/store/user/domain/_
 *
 * Ports legacy/cb/services/credential_service.py.
 */
import type { CloudBeesClient } from "../../core/api/types";
import { CredentialDTO, credentialFromDict } from "../../core/dtos/index";
import { buildUsernamePasswordCredXml } from "./xml-builder";

/** Valid store choices — exposed for CLI validation. */
export const CREDENTIAL_STORES = ["system", "user"] as const;
/** Union of the two valid store values: `"system"` or `"user"`. */
export type CredentialStore = (typeof CREDENTIAL_STORES)[number];

/** REST path segment for the credential store. */
export function getUserSeg(username = "", store: string = "system"): string {
  if (store === "user" && username && username.toLowerCase() !== "system") {
    return `/user/${username}/credentials/store/user/domain/_`;
  }
  return "/credentials/store/system/domain/_";
}

/** Lists credentials in the resolved store, requesting `id,typeName,description,scope,displayName` fields. Results are cached per `baseUrl` + store. */
export async function listCredentials(
  client: CloudBeesClient,
  username = "",
  store = "system",
): Promise<CredentialDTO[]> {
  const userSeg = getUserSeg(username, store);
  const data = await client.get<{ credentials?: unknown[] }>(
    `${userSeg}/api/json?tree=credentials[id,typeName,description,scope,displayName]`,
    { cacheKey: `credentials.list.${client.baseUrl}.${store}` },
  );
  return (data?.credentials ?? []).map((c) => credentialFromDict(c as Record<string, unknown>));
}

/** Fetches a single credential by ID from `<storePath>/credential/<credId>/api/json`. */
export async function getCredential(
  client: CloudBeesClient,
  credId: string,
  username = "",
  store = "system",
): Promise<CredentialDTO> {
  const userSeg = getUserSeg(username, store);
  const data = await client.get<Record<string, unknown>>(
    `${userSeg}/credential/${credId}/api/json`,
    { cacheKey: `credentials.detail.${credId}.${store}` },
  );
  return credentialFromDict(data ?? {});
}

/**
 * Read a credential's username + description from its config.xml.
 *
 * Jenkins NEVER returns the password/secret (it is write-only), so the edit
 * form cannot prefill it — only username and description can be shown as their
 * real current values. Returns "" for each field that isn't present.
 */
export async function getCredentialConfig(
  client: CloudBeesClient,
  credId: string,
  username = "",
  store = "system",
): Promise<{ username: string; description: string }> {
  const userSeg = getUserSeg(username, store);
  const xml = await client.getText(`${userSeg}/credential/${credId}/config.xml`);
  const pick = (tag: string): string => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!m || m[1] === undefined) return "";
    return m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
  };
  return { username: pick("username"), description: pick("description") };
}

/**
 * Posts a `Username with password` credential XML to `<storePath>/createCredentials`.
 * Scope defaults to `GLOBAL`; `store="user"` scopes it to the per-user store.
 */
export async function createUsernamePassword(
  client: CloudBeesClient,
  credId: string,
  usernameCred: string,
  password: string,
  desc = "",
  scope = "GLOBAL",
  username = "",
  store = "system",
): Promise<void> {
  const userSeg = getUserSeg(username, store);
  const xml = buildUsernamePasswordCredXml(credId, usernameCred, password, desc, scope);
  await client.postXml(`${userSeg}/createCredentials`, xml, { invalidate: "credentials." });
}

/** Deletes a credential via `<storePath>/credential/<credId>/doDelete`. Invalidates the `credentials.` cache. */
export async function deleteCredential(
  client: CloudBeesClient,
  credId: string,
  username = "",
  store = "system",
): Promise<void> {
  const userSeg = getUserSeg(username, store);
  await client.post(`${userSeg}/credential/${credId}/doDelete`, { invalidate: "credentials." });
}

/**
 * Partial update of a credential's config.xml — only overwrites provided fields.
 * Mirrors the Python ET-based partial update via string-level replacement.
 */
export async function updateCredential(
  client: CloudBeesClient,
  credId: string,
  usernameCred?: string,
  password?: string,
  desc?: string,
  username = "",
  store = "system",
): Promise<void> {
  const userSeg = getUserSeg(username, store);
  let xml = await client.getText(`${userSeg}/credential/${credId}/config.xml`);

  const setElement = (src: string, tag: string, value: string): string => {
    const re = new RegExp(`(<${tag}>)[\\s\\S]*?(</${tag}>)`);
    const escaped = value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (re.test(src)) return src.replace(re, `$1${escaped}$2`);
    // Insert before the root closing tag if missing.
    return src.replace(/(\n?)(<\/[A-Za-z0-9_.$]+>\s*)$/, `\n  <${tag}>${escaped}</${tag}>$1$2`);
  };

  if (usernameCred !== undefined) xml = setElement(xml, "username", usernameCred);
  if (password !== undefined) xml = setElement(xml, "password", password);
  if (desc !== undefined) xml = setElement(xml, "description", desc);

  await client.postXml(`${userSeg}/credential/${credId}/config.xml`, xml, {
    invalidate: "credentials.",
  });
}
