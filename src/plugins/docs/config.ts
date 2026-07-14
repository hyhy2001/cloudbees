/**
 * LM endpoint configuration for `bee ask`.
 *
 * The backend speaks the OpenAI API shape, so the chat/embedding paths are
 * fixed at `/v1/chat/completions` and `/v1/embeddings` — CB_LM_URL is the base
 * (host, or host + a prefix like `/v1`) and the paths are appended. Auth is a
 * single static key sent as both `Authorization: Bearer` and `X-Api-Key`.
 *
 * Priority order (highest wins):
 *   1. Runtime env  — CB_LM_URL / CB_API_KEY / CB_LM_MODEL / ...
 *   2. Runtime file — ~/.config/bee/lm.json  or  ./bee.lm.json  (read at startup)
 *   3. Build-time   — baked at compile time via bee.lm.json (team internal builds only)
 *
 * For public/distributed binaries, sources 1+2 are sufficient — no credentials
 * need to be baked into the binary. bee.lm.json is gitignored.
 */

import { xorDecode } from "../../core/obfuscate";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

declare const BEE_LM_URL: string | undefined;
declare const BEE_LM_API_KEY: string | undefined;
declare const BEE_LM_MODEL: string | undefined;
declare const BEE_EMBEDDING_MODEL: string | undefined;
declare const BEE_EMBEDDING_URL: string | undefined;
declare const BEE_REWRITE_MODEL: string | undefined;

/** OpenAI-standard endpoint paths — fixed, not configurable. */
export const CHAT_PATH = "/v1/chat/completions";
export const EMBEDDING_PATH = "/v1/embeddings";

interface LmFileConfig {
  url?: string; apiKey?: string; model?: string; rewriteModel?: string;
  embeddingModel?: string; embeddingUrl?: string;
  // legacy keys
  CB_LM_URL?: string; CB_API_KEY?: string; CB_LM_MODEL?: string;
  CB_REWRITE_MODEL?: string;
  CB_EMBEDDING_MODEL?: string; CB_EMBEDDING_URL?: string;
}

/** Read lm.json from ~/.config/bee/lm.json or ./bee.lm.json at runtime. */
function readRuntimeConfig(): LmFileConfig {
  if (process.env["CB_SKIP_LM_FILE"] === "1") return {};
  const candidates = [
    join(homedir(), ".config", "bee", "lm.json"),
    join(process.cwd(), "bee.lm.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")) as LmFileConfig; } catch { /* skip */ }
    }
  }
  return {};
}

const _rc = readRuntimeConfig();

/** Priority: env > runtime file > baked binary value */
function pick(baked: string | undefined, fileVal: string | undefined, envKey: string): string {
  const env = process.env[envKey];
  if (env) return env;
  if (fileVal) return fileVal;
  if (typeof baked !== "undefined" && baked !== "") return xorDecode(baked);
  return "";
}

/** Ensure a URL-like string has a protocol prefix; fetch() requires one. */
function ensureProtocol(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) return url;
  return `https://${url}`;
}

/**
 * Join a base URL and a path, collapsing a duplicated leading segment.
 * Users often set CB_LM_URL to ".../v1" while the default chat/embedding
 * paths also start with "/v1", which would yield ".../v1/v1/chat/completions".
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
  _rc.apiKey ?? _rc.CB_API_KEY,
  "CB_API_KEY",
);
export const LM_MODEL =
  pick(typeof BEE_LM_MODEL !== "undefined" ? BEE_LM_MODEL : undefined, _rc.model ?? _rc.CB_LM_MODEL, "CB_LM_MODEL") ||
  "default";
export const REWRITE_MODEL =
  pick(typeof BEE_REWRITE_MODEL !== "undefined" ? BEE_REWRITE_MODEL : undefined, _rc.rewriteModel ?? _rc.CB_REWRITE_MODEL, "CB_REWRITE_MODEL") ||
  LM_MODEL;
const BASE_URL = ensureProtocol(
  pick(
    typeof BEE_LM_URL !== "undefined" ? BEE_LM_URL : undefined,
    _rc.url ?? _rc.CB_LM_URL,
    "CB_LM_URL",
  ),
);
export const LM_URL = BASE_URL;
export const CHAT_ENDPOINT = BASE_URL ? joinUrl(BASE_URL, CHAT_PATH) : "";
export const EMBEDDING_MODEL =
  pick(typeof BEE_EMBEDDING_MODEL !== "undefined" ? BEE_EMBEDDING_MODEL : undefined, _rc.embeddingModel ?? _rc.CB_EMBEDDING_MODEL, "CB_EMBEDDING_MODEL") ||
  "default";
const EXPLICIT_EMBEDDING_URL = ensureProtocol(
  pick(typeof BEE_EMBEDDING_URL !== "undefined" ? BEE_EMBEDDING_URL : undefined, _rc.embeddingUrl ?? _rc.CB_EMBEDDING_URL, "CB_EMBEDDING_URL"),
);
export const EMBEDDING_URL = EXPLICIT_EMBEDDING_URL ||
  (BASE_URL ? joinUrl(BASE_URL, EMBEDDING_PATH) : "");
