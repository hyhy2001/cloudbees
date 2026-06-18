/**
 * LM endpoint configuration for `bee ask`.
 *
 * Two sources, in priority order:
 *   1. Build-time baked values — injected by build.ts via `Bun.build({ define })`
 *      from `bee.lm.json` (or CB_* env at build). Inlined as string literals into
 *      the compiled binary, so a copied binary carries its own config and stays
 *      "all in one". The `declare const` below are replaced at compile time;
 *      `bun run` dev mode leaves them undefined.
 *   2. Runtime env — CB_DATABRICK_URL / CB_API_KEY / CB_LM_MODEL. Lets a dev run
 *      from source against a local llama-server without rebuilding.
 *
 * When LM_URL is empty (no config baked, no env), no provider is registered and
 * `bee ask` runs fully offline.
 */

declare const BEE_LM_URL: string | undefined;
declare const BEE_LM_API_KEY: string | undefined;
declare const BEE_LM_MODEL: string | undefined;

function pick(baked: string | undefined, envKey: string): string {
  if (typeof baked !== "undefined" && baked !== "") return baked;
  return process.env[envKey] ?? "";
}

export const LM_URL = pick(
  typeof BEE_LM_URL !== "undefined" ? BEE_LM_URL : undefined,
  "CB_DATABRICK_URL",
);
export const LM_API_KEY = pick(
  typeof BEE_LM_API_KEY !== "undefined" ? BEE_LM_API_KEY : undefined,
  "CB_API_KEY",
);
export const LM_MODEL =
  pick(typeof BEE_LM_MODEL !== "undefined" ? BEE_LM_MODEL : undefined, "CB_LM_MODEL") ||
  "default";
