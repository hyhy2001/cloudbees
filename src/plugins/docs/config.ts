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
declare const BEE_PATH_PREFIX: string | undefined;

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
const LM_PATH_PREFIX = pick(
  typeof BEE_PATH_PREFIX !== "undefined" ? BEE_PATH_PREFIX : undefined,
  "CB_PATH_PREFIX",
);
// LM_URL is the base (for OAuth, host detection). API_BASE_URL adds path prefix
// for actual API calls (chat, embeddings) — e.g. /ai-gateway/mlflow.
const BASE_URL = ensureProtocol(
  pick(
    typeof BEE_LM_URL !== "undefined" ? BEE_LM_URL : undefined,
    "CB_DATABRICK_URL",
  ),
);
export const LM_URL = BASE_URL;
export const API_BASE_URL = BASE_URL ? `${BASE_URL.replace(/\/+$/, "")}${LM_PATH_PREFIX}` : "";
export const EMBEDDING_MODEL =
  pick(typeof BEE_EMBEDDING_MODEL !== "undefined" ? BEE_EMBEDDING_MODEL : undefined, "CB_EMBEDDING_MODEL") ||
  "Xenova/all-MiniLM-L6-v2";
const EXPLICIT_EMBEDDING_URL = ensureProtocol(
  pick(typeof BEE_EMBEDDING_URL !== "undefined" ? BEE_EMBEDDING_URL : undefined, "CB_EMBEDDING_URL"),
);
export const EMBEDDING_URL = EXPLICIT_EMBEDDING_URL ||
  (EMBEDDING_MODEL !== "Xenova/all-MiniLM-L6-v2" && API_BASE_URL
    ? `${API_BASE_URL.replace(/\/+$/, "")}/v1/embeddings`
    : "");
