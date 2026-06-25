/**
 * Pre-compute neural embeddings for the entire corpus using a local ONNX
 * embedding model (all-MiniLM-L6-v2 via @xenova/transformers).
 *
 * The generated file is committed and baked into the binary — no model
 * needed at runtime.
 *
 * Run: bun run scripts/generate-embeddings.ts
 *
 * First run downloads the model (~80 MB) to the HuggingFace cache.
 * Subsequent runs use the cached model.
 */

import { writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

const lmFile = (await Bun.file("bee.lm.json").json().catch(() => ({}))) as Record<string, string>;
const MODEL_NAME = lmFile.embeddingModel ?? lmFile.CB_EMBEDDING_MODEL ?? process.env.CB_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const BASE_URL = lmFile.url ?? lmFile.CB_DATABRICK_URL ?? process.env.CB_DATABRICK_URL ?? "";
const API_KEY = lmFile.apiKey ?? lmFile.CB_API_KEY ?? process.env.CB_API_KEY ?? "";
const CLI_ID = lmFile.clientId ?? lmFile.CB_CLIENT_ID ?? process.env.CB_CLIENT_ID ?? "";
const CLI_SEC = lmFile.clientSecret ?? lmFile.CB_CLIENT_SECRET ?? process.env.CB_CLIENT_SECRET ?? "";
const PATH_PREFIX = lmFile.pathPrefix ?? lmFile.CB_PATH_PREFIX ?? process.env.CB_PATH_PREFIX ?? "";
const EMBEDDING_URL_OVERRIDE = lmFile.embeddingUrl ?? lmFile.CB_EMBEDDING_URL ?? process.env.CB_EMBEDDING_URL ?? "";
const API_URL = EMBEDDING_URL_OVERRIDE ||
  (MODEL_NAME !== "Xenova/all-MiniLM-L6-v2" && BASE_URL
    ? `${BASE_URL.replace(/\/+$/, "")}${PATH_PREFIX}/v1/embeddings`
    : "");

// Auth: OAuth → Bearer, else static API_KEY
let BEARER = API_KEY;
if (CLI_ID && CLI_SEC && !BEARER) {
  try {
    const r = await fetch(`${BASE_URL.replace(/\/+$/, "")}/oidc/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&scope=all-apis&client_id=${CLI_ID}&client_secret=${CLI_SEC}`,
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) BEARER = ((await r.json()) as { access_token: string }).access_token;
  } catch { /* fall through */ }
}

const { initPlugins } = await import("../src/registry");
const { buildCorpus } = await import("../src/plugins/docs/corpus");

console.log("Building corpus…");
const program = new Command("bee");
program.exitOverride();
await initPlugins(program);
const corpus = buildCorpus(program);

type EmbedFn = (text: string) => Promise<number[]>;
let embed: EmbedFn;
let DIM = 384;

if (API_URL) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (BEARER) headers["authorization"] = `Bearer ${BEARER}`;
  process.stderr.write(`  Embedding URL: ${API_URL} auth=${BEARER ? "Bearer" : "none"}\n`);
  // Try the configured URL first, fallback to base URL without prefix
  // (embedding models may not route through AI Gateway).
  const urlCandidates = [API_URL];
  if (PATH_PREFIX) {
    urlCandidates.push(`${BASE_URL.replace(/\/+$/, "")}/v1/embeddings`);
    urlCandidates.push(`${BASE_URL.replace(/\/+$/, "")}/serving-endpoints/${encodeURIComponent(MODEL_NAME)}/invocations`);
  }
  embed = async (t: string) => {
    for (const url of urlCandidates) {
      process.stderr.write(`    → trying ${url}\n`);
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: t.slice(0, 2048), model: MODEL_NAME }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) {
        const j = (await r.json()) as { data?: Array<{ embedding: number[] }> };
        return j.data?.[0]?.embedding ?? [];
      }
      if (r.status !== 404) {
        throw new Error(`Embedding API returned ${r.status} at ${url}`);
      }
      process.stderr.write(`  Embedding API 404 at ${url} — trying next candidate\n`);
    }
    throw new Error(`Embedding API returned 404 for all candidates`);
  };
  console.log("Using API embedding…");
  // Detect dimension from first response
  const first = await embed(corpus[0]!.title);
  DIM = first.length;
} else {
  const { pipeline, env } = await import("@xenova/transformers");
  const repoModels = join(import.meta.dir, "..", "models");
  if (statSync(repoModels, { throwIfNoEntry: false })) {
    env.cacheDir = repoModels;
    env.localModelPath = repoModels;
  }
  console.log("Loading embedding model (first run downloads ~80 MB)…");
  const extract = await pipeline("feature-extraction", MODEL_NAME);
  embed = async (t: string) => {
    const result = await extract(t.slice(0, 512), { pooling: "mean", normalize: true });
    return Array.from(result.data) as number[];
  };
}

const ids: string[] = [];
const values: number[] = [];

for (const item of corpus) {
  const text = [item.title, item.description, item.body].filter(Boolean).join(" ").slice(0, 512);
  const result = await embed(text);
  const vec = Array.from(result) as number[];
  ids.push(item.id);
  values.push(...vec);

  if (ids.length % 20 === 0) console.log(`  ${ids.length}/${corpus.length}`);
}

// Quantize to Int16: round(float * SCALE), clamp to [-32768, 32767]
const SCALE = 10000;
const quantized = new Int16Array(values.length);
for (let i = 0; i < values.length; i++) {
  const v = Math.round(values[i]! * SCALE);
  quantized[i] = Math.max(-32768, Math.min(32767, v));
}

const base64 = Buffer.from(quantized.buffer).toString("base64");

const outPath = join(import.meta.dir, "..", "src", "generated", "embeddings.ts");
const code = [
  "// Auto-generated by scripts/generate-embeddings.ts — do not edit manually.",
  "// Uses Xenova/all-MiniLM-L6-v2 (384-dim, ONNX, local).",
  `// Generated: ${new Date().toISOString()}`,
  `// Corpus: ${ids.length} items × ${DIM} dim`,
  "",
  `export const DIM = ${DIM} as const;`,
  `export const SCALE = ${SCALE} as const;`,
  `export const VEC_IDS: readonly string[] = ${JSON.stringify(ids)};`,
  "",
  `// Quantized Int16 flat array (base64).`,
  `export const VEC_B64 = "${base64}";`,
].join("\n");

writeFileSync(outPath, code, "utf-8");
console.log(`\n✓ ${ids.length}×${DIM} (${quantized.byteLength} bytes) → ${outPath}`);
