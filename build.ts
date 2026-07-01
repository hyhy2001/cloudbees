/**
 * bee — CloudBees CLI build script.
 * Compiles the TypeScript source into a single standalone binary for RHEL8 (glibc 2.28+).
 *
 * Output: ./dist/bee
 */

import { randomBytes } from "node:crypto";
import { xorEncode } from "./src/core/obfuscate";

/** Obfuscate a sensitive string so it doesn't appear in `strings ./bee`. */
function obf(value: string): string {
  if (!value) return "";
  return xorEncode(value, randomBytes(16));
}

const VERSION =
  (await Bun.file("package.json").json().then((p) => p.version).catch(() => "0.0.0")) ?? "0.0.0";

console.log(`Building bee v${VERSION} → ./dist/bee`);

// ─── LM endpoint config (baked into the binary) ──────────────────────────────
// Source priority: bee.lm.json (gitignored) → CB_* env → empty (offline binary).
// Values are inlined as string literals via `define`, so a copied binary carries
// its own config. The API key is embedded in the binary (extractable via
// `strings`); only bake keys whose scope you accept being shipped in the binary.
interface LmConfig {
  url?: string;
  apiKey?: string;
  model?: string;
  clientId?: string;
  clientSecret?: string;
  chatPath?: string;
  embeddingModel?: string;
  embeddingUrl?: string;
  embeddingPath?: string;
  // Legacy keys from bee.lm.json (env-var-named)
  CB_DATABRICK_URL?: string;
  CB_API_KEY?: string;
  CB_LM_MODEL?: string;
  CB_CLIENT_ID?: string;
  CB_CLIENT_SECRET?: string;
  CB_EMBEDDING_MODEL?: string;
  CB_EMBEDDING_URL?: string;
  CB_EMBEDDING_PATH?: string;
  CB_CHAT_PATH?: string;
  CB_REWRITE_MODEL?: string;
  rewriteModel?: string;
}
const lmFile = (await Bun.file("bee.lm.json")
  .json()
  .catch(() => ({}))) as LmConfig;

const LM_URL = lmFile.url ?? lmFile.CB_DATABRICK_URL ?? process.env.CB_DATABRICK_URL ?? "";
const LM_API_KEY = lmFile.apiKey ?? lmFile.CB_API_KEY ?? process.env.CB_API_KEY ?? "";
const LM_MODEL = lmFile.model ?? lmFile.CB_LM_MODEL ?? process.env.CB_LM_MODEL ?? "";
const LM_CLIENT_ID = lmFile.clientId ?? lmFile.CB_CLIENT_ID ?? process.env.CB_CLIENT_ID ?? "";
const LM_CLIENT_SECRET = lmFile.clientSecret ?? lmFile.CB_CLIENT_SECRET ?? process.env.CB_CLIENT_SECRET ?? "";
const EMBEDDING_MODEL = lmFile.embeddingModel ?? lmFile.CB_EMBEDDING_MODEL ?? process.env.CB_EMBEDDING_MODEL ?? "default";
const EMBEDDING_PATH = lmFile.embeddingPath ?? lmFile.CB_EMBEDDING_PATH ?? process.env.CB_EMBEDDING_PATH ?? "/v1/embeddings";
const EMBEDDING_URL = lmFile.embeddingUrl ?? lmFile.CB_EMBEDDING_URL ?? process.env.CB_EMBEDDING_URL ??
  (LM_URL ? `${LM_URL.replace(/\/+$/, "")}${EMBEDDING_PATH}` : "");
const REWRITE_MODEL = lmFile.rewriteModel ?? lmFile.CB_REWRITE_MODEL ?? process.env.CB_REWRITE_MODEL ?? LM_MODEL;
if (EMBEDDING_URL) process.stderr.write(`  Embedding: ${EMBEDDING_MODEL} @ ${EMBEDDING_URL}\n`);
if (REWRITE_MODEL && REWRITE_MODEL !== LM_MODEL) process.stderr.write(`  Rewrite model: ${REWRITE_MODEL}\n`);

const SKIP_CODEGEN = process.env["CB_SKIP_CODEGEN"] === "1";

if (!SKIP_CODEGEN) {
  await Bun.$`bun run scripts/generate-help-index.ts`;
}

// Generate pre-built embeddings (@xenova/transformers optional).
if (!SKIP_CODEGEN) {
  try {
    await Bun.$`bun run scripts/generate-embeddings.ts`;
  } catch {
    console.log("  Vector embeddings: generation failed — BM25-only search at runtime.");
  }
}

// No local model bundling — embedding is always API-based.
await Bun.write("src/generated/embedding-model.ts", `// API-based embedding — no local model files.
export const MODEL_FILES: Record<string, string> = {};
`);

// Generate build-time synonym map (LLM alternative verbs for commands).
// This runs after embeddings so both neural and synonym data are available.
if (!SKIP_CODEGEN) {
  try {
    await Bun.$`bun run scripts/generate-synonyms.ts`;
  } catch {
    console.log("  Synonyms: skipped (LM endpoint not available)");
  }
}

// ─── LM endpoint config (baked into the binary) ──────────────────────────────
// Source priority: bee.lm.json (gitignored) → CB_* env → empty (offline binary).
// Values are inlined as string literals via `define`, so a copied binary carries
// its own config. The API key is embedded in the binary (extractable via
// `strings`); only bake keys whose scope you accept being shipped in the binary.
// Never log the key — only whether the LM is wired and to which endpoint.
console.log(
  LM_URL
    ? `  LM provider: ENABLED → ${LM_URL}${LM_CLIENT_ID ? " (OAuth client credentials)" : LM_API_KEY ? " (authenticated)" : " (no key)"}`
    : "  LM provider: disabled (offline-only binary)",
);

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  // Standalone executable for RHEL8 (glibc 2.28+). baseline = no AVX2 requirement.
  compile: { target: "bun-linux-x64-baseline", outfile: "./dist/bee" },
  minify: true,
  // NOTE: bytecode is intentionally NOT enabled. Ink's flexbox engine
  // (yoga-layout) fails to compile with bytecode. minify alone is fine.
  sourcemap: "linked",
  define: {
    BEE_VERSION: `"${VERSION}"`,
    BEE_LM_URL: JSON.stringify(obf(LM_URL)),
    BEE_LM_API_KEY: JSON.stringify(obf(LM_API_KEY)),
    BEE_LM_MODEL: JSON.stringify(obf(LM_MODEL)),
    BEE_LM_CLIENT_ID: JSON.stringify(obf(LM_CLIENT_ID)),
    BEE_LM_CLIENT_SECRET: JSON.stringify(obf(LM_CLIENT_SECRET)),
    BEE_EMBEDDING_MODEL: JSON.stringify(obf(EMBEDDING_MODEL)),
    BEE_EMBEDDING_URL: JSON.stringify(obf(EMBEDDING_URL)),
    BEE_EMBEDDING_PATH: JSON.stringify(obf(EMBEDDING_PATH)),
    BEE_REWRITE_MODEL: JSON.stringify(obf(REWRITE_MODEL)),
    BEE_CHAT_PATH: JSON.stringify(obf(lmFile.chatPath ?? lmFile.CB_CHAT_PATH ?? process.env.CB_CHAT_PATH ?? "/v1/chat/completions")),
  },
  jsx: {
    runtime: "automatic",
    importSource: "react",
    // CRITICAL: emit the production JSX runtime (jsx/jsxs), not jsxDEV.
    // The compiled binary has no jsxDEV symbol, so a dev-runtime build crashes
    // at first render with "<minified> is not a function". Neither NODE_ENV
    // (spawn env or --define) nor --compile/--production flip this — only this
    // explicit flag does. Verified against bun 1.3.x.
    development: false,
  },
});

if (!result.success) {
  console.error("\nBinary compilation failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("\n  ✓ Binary built: ./dist/bee\n");

export {};
