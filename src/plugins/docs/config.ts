/**
 * LM endpoint configuration for `bee ask`.
 *
 * Two sources, in priority order:
 *   1. Build-time baked values — injected by build.ts via `Bun.build({ define })`
 *      from `bee.lm.json` (or CB_* env at build). Inlined as string literals into
 *      the compiled binary, so a copied binary carries its own config and stays
 *      "all in one". The `declare const` below are replaced at compile time;
 *      `bun run` dev mode leaves them undefined.
 *   2. Runtime env — CB_DATABRICK_URL / CB_API_KEY / CB_LM_MODEL /
 *      CB_CLIENT_ID / CB_CLIENT_SECRET. Lets a dev run from source without rebuilding.
 *
 * Auth priority:
 *   - CB_CLIENT_ID + CB_CLIENT_SECRET  → Databricks OAuth client credentials
 *     (exchanges for a short-lived token before each fresh generation run)
 *   - CB_API_KEY                        → static Bearer token (Databricks PAT, llama-server)
 *   - neither                           → unauthenticated (local dev server)
 *
 * When LM_URL is empty (no config baked, no env), no provider is registered and
 * `bee ask` runs fully offline.
 */

declare const BEE_LM_URL: string | undefined;
declare const BEE_LM_API_KEY: string | undefined;
declare const BEE_LM_MODEL: string | undefined;
declare const BEE_LM_CLIENT_ID: string | undefined;
declare const BEE_LM_CLIENT_SECRET: string | undefined;
declare const BEE_EMBEDDING_MODEL: string | undefined;
declare const BEE_EMBEDDING_URL: string | undefined;
declare const BEE_CHAT_PATH: string | undefined;
declare const BEE_EMBEDDING_PATH: string | undefined;

function pick(baked: string | undefined, envKey: string): string {
  if (typeof baked !== "undefined" && baked !== "") return baked;
  return process.env[envKey] ?? "";
}

/** Ensure a URL-like string has a protocol prefix; fetch() requires one. */
function ensureProtocol(url: string): string {
  if (!url) return url;
  // Already has protocol or looks like a path (relative URL).
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) return url;
  return `https://${url}`;
}

/**
 * Join a base URL and a path, collapsing a duplicated leading segment.
 * Users often set CB_DATABRICK_URL to ".../v1" while the default chat/embedding
 * paths also start with "/v1", which would yield ".../v1/v1/chat/completions".
 * If base already ends with path's first segment, drop it from the base.
 */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const firstSeg = path.replace(/^\/+/, "").split("/")[0];
  if (firstSeg && b.endsWith(`/${firstSeg}`)) {
    return `${b.slice(0, -(firstSeg.length + 1))}${path}`;
  }
  return `${b}${path}`;
}

export const LM_API_KEY = pick(
  typeof BEE_LM_API_KEY !== "undefined" ? BEE_LM_API_KEY : undefined,
  "CB_API_KEY",
);
export const LM_MODEL =
  pick(typeof BEE_LM_MODEL !== "undefined" ? BEE_LM_MODEL : undefined, "CB_LM_MODEL") ||
  "default";
export const LM_CLIENT_ID = pick(
  typeof BEE_LM_CLIENT_ID !== "undefined" ? BEE_LM_CLIENT_ID : undefined,
  "CB_CLIENT_ID",
);
export const LM_CLIENT_SECRET = pick(
  typeof BEE_LM_CLIENT_SECRET !== "undefined" ? BEE_LM_CLIENT_SECRET : undefined,
  "CB_CLIENT_SECRET",
);
const CHAT_PATH = pick(
  typeof BEE_CHAT_PATH !== "undefined" ? BEE_CHAT_PATH : undefined,
  "CB_CHAT_PATH",
) || "/v1/chat/completions";
const EMBEDDING_PATH = pick(
  typeof BEE_EMBEDDING_PATH !== "undefined" ? BEE_EMBEDDING_PATH : undefined,
  "CB_EMBEDDING_PATH",
) || "/v1/embeddings";
export { EMBEDDING_PATH };
// LM_URL is the base (for OAuth, host detection). For chat/embedding, append
// the corresponding path (default /v1/chat/completions, /v1/embeddings).
const BASE_URL = ensureProtocol(
  pick(
    typeof BEE_LM_URL !== "undefined" ? BEE_LM_URL : undefined,
    "CB_DATABRICK_URL",
  ),
);
export const LM_URL = BASE_URL;
export const CHAT_ENDPOINT = BASE_URL ? joinUrl(BASE_URL, CHAT_PATH) : "";
export const EMBEDDING_MODEL =
  pick(typeof BEE_EMBEDDING_MODEL !== "undefined" ? BEE_EMBEDDING_MODEL : undefined, "CB_EMBEDDING_MODEL") ||
  "default";
const EXPLICIT_EMBEDDING_URL = ensureProtocol(
  pick(typeof BEE_EMBEDDING_URL !== "undefined" ? BEE_EMBEDDING_URL : undefined, "CB_EMBEDDING_URL"),
);
export const EMBEDDING_URL = EXPLICIT_EMBEDDING_URL ||
  (BASE_URL ? joinUrl(BASE_URL, EMBEDDING_PATH) : "");
