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
import { NotFoundError, ValidationError } from "../../core/api/errors";
import { buildUsernamePasswordCredXml, buildSecretTextCredXml } from "./xml-builder";
import { XMLParser } from "fast-xml-parser";

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
  try {
    const data = await client.get<{ credentials?: unknown[] }>(
      `${userSeg}/api/json?tree=credentials[id,typeName,description,scope,displayName]`,
      { cacheKey: `credentials.list.${client.baseUrl}.${store}` },
    );
    return (data?.credentials ?? []).map((c) => credentialFromDict(c as Record<string, unknown>));
  } catch (err) {
    // 404 means this controller has no credentials store endpoint (plugin not
    // installed, or store disabled) — that's an empty list, not a hard error.
    if (err instanceof NotFoundError) return [];
    throw err;
  }
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
    { cacheKey: `credentials.detail.${client.baseUrl}.${credId}.${store}` },
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
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const doc = parser.parse(xml) as Record<string, unknown>;
  // Root element name varies by credential type; skip the XML declaration node.
  const root = Object.entries(doc)
    .filter(([k]) => k !== "?xml")
    .map(([, v]) => v)
    .find((v) => v !== null && typeof v === "object") as Record<string, unknown> | undefined;
  const pick = (key: string): string => {
    const val = root?.[key];
    if (val === null || val === undefined) return "";
    return String(val).trim();
  };
  return { username: pick("username"), description: pick("description") };
}

/** Creates a SecretText credential via `<storePath>/createCredentials`. Scope defaults to `GLOBAL`. */
export async function createSecretText(
  client: CloudBeesClient,
  credId: string,
  secret: string,
  desc = "",
  scope = "GLOBAL",
  username = "",
  store = "system",
): Promise<void> {
  try {
    await getCredential(client, credId, username, store);
    throw new ValidationError(`Credential "${credId}" already exists.`);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  const userSeg = getUserSeg(username, store);
  const xml = buildSecretTextCredXml(credId, secret, desc, scope);
  await client.postXml(`${userSeg}/createCredentials`, xml, { invalidate: "credentials." });
}

/** Creates a `Username with password` credential XML to `<storePath>/createCredentials`.
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
  try {
    await getCredential(client, credId, username, store);
    throw new ValidationError(`Credential "${credId}" already exists.`);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
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
    // Match <tag> or <tag attr="..."> — Jenkins re-serializes tags with class attributes.
    const re = new RegExp(`(<${tag}(?:\\s[^>]*)?>)[\\s\\S]*?(</${tag}>)`);
    const escaped = value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (re.test(src)) return src.replace(re, `$1${escaped}$2`);
    // Insert before the root closing tag — only alphanumeric + dot + hyphen (valid XML names).
    const rootCloseRe = /(\n?)(<\/[A-Za-z][A-Za-z0-9._-]*>\s*)$/;
    if (!rootCloseRe.test(src)) {
      throw new Error(`updateCredential: cannot insert <${tag}> — root closing tag not found in config.xml`);
    }
    return src.replace(rootCloseRe, `\n  <${tag}>${escaped}</${tag}>$1$2`);
  };

  if (usernameCred !== undefined) xml = setElement(xml, "username", usernameCred);
  if (password !== undefined) {
    // The secret value lives in a different tag per credential type: SecretText
    // (StringCredentialsImpl) stores it in <secret>, UsernamePassword in
    // <password>. Writing the wrong tag inserts a dead element Jenkins ignores
    // while the real secret stays unchanged — a silent no-op that reports success
    // (e.g. rotating a leaked token would leave it live). Target whichever tag the
    // fetched config.xml actually has.
    const secretTag = /<secret(?:\s[^>]*)?>/.test(xml) ? "secret" : "password";
    xml = setElement(xml, secretTag, password);
  }
  if (desc !== undefined) xml = setElement(xml, "description", desc);

  await client.postXml(`${userSeg}/credential/${credId}/config.xml`, xml, {
    invalidate: "credentials.",
  });
}
