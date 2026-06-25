/**
 * Build-time synonym map generator.
 *
 * For each command in the corpus, asks the LLM to suggest alternative
 * user phrasings/verbs. Writes the generated map to src/generated/synonyms.ts.
 *
 * This runs once at build time, so the LLM cost is O(corpus) per build,
 * not O(queries) per user. The generated file is bundled into the binary.
 *
 * Run: bun run scripts/generate-synonyms.ts
 * Requires LM_URL env (same as bee ask).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

const { initPlugins } = await import("../src/registry");
const { buildCorpus } = await import("../src/plugins/docs/corpus");

// ---- LLM config ------------------------------------------------------------

interface LmConfig {
  url?: string;
  apiKey?: string;
  model?: string;
  pathPrefix?: string;
  clientId?: string;
  clientSecret?: string;
  CB_DATABRICK_URL?: string;
  CB_API_KEY?: string;
  CB_LM_MODEL?: string;
  CB_PATH_PREFIX?: string;
  CB_CLIENT_ID?: string;
  CB_CLIENT_SECRET?: string;
}

function ensureProtocol(url: string): string {
  if (!url) return "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) return "https://" + url;
  return url;
}

const lmFile = (await Bun.file("bee.lm.json").json().catch(() => ({}))) as LmConfig;

const BASE_URL = ensureProtocol(
  lmFile.url ?? lmFile.CB_DATABRICK_URL ?? process.env["CB_DATABRICK_URL"] ?? process.env["CB_LM_URL"] ?? "",
);
const PATH_PREFIX = lmFile.pathPrefix ?? lmFile.CB_PATH_PREFIX ?? process.env["CB_PATH_PREFIX"] ?? "";
const LM_API_KEY = lmFile.apiKey ?? lmFile.CB_API_KEY ?? process.env["CB_API_KEY"] ?? "";
const CLI_ID = lmFile.clientId ?? lmFile.CB_CLIENT_ID ?? process.env["CB_CLIENT_ID"] ?? "";
const CLI_SEC = lmFile.clientSecret ?? lmFile.CB_CLIENT_SECRET ?? process.env["CB_CLIENT_SECRET"] ?? "";
const LM_MODEL = lmFile.model ?? lmFile.CB_LM_MODEL ?? process.env["CB_LM_MODEL"] ?? "oc/deepseek-v4-flash-free";
const API_BASE = BASE_URL ? `${BASE_URL.replace(/\/+$/, "")}${PATH_PREFIX}` : "";

if (!API_BASE) {
  console.error("Set CB_DATABRICK_URL or create bee.lm.json to use this script.");
  process.exit(1);
}

// Auth: OAuth (client_id + client_secret) → Bearer token, else static API_KEY
let BEARER = LM_API_KEY;
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

const headers: Record<string, string> = { "content-type": "application/json" };
if (BEARER) headers["authorization"] = `Bearer ${BEARER}`;

// Quick connectivity: POST tiny chat (max_tokens=1) — /v1/models may not exist on AI Gateways.
try {
  const health = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: LM_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 1, temperature: 0 }),
    signal: AbortSignal.timeout(10000),
  });
  if (health.status === 404) {
    console.error(`LM endpoint at ${API_BASE} returned 404 — endpoint may not support chat (synonym generation skipped).`);
    process.exit(1);
  }
} catch {
  console.error(`LM endpoint at ${API_BASE} is unreachable — skipping synonym generation.`);
  process.exit(1);
}

// ---- Build corpus -----------------------------------------------------------

const program = new Command("bee");
program.exitOverride();
await initPlugins(program);
const corpus = buildCorpus(program);

// ---- Generate synonyms for each command -------------------------------------

const promptTemplate = [
  "You are a CLI synonym generator.",
  "For the command below, list 3-5 single-word alternative verbs a user might use instead.",
  "Command action: ${action}",
  "Command description: ${desc}",
  "",
  "Return ONLY comma-separated lowercase words, no punctuation or explanation:",
].join("\n");

const synonyms: Record<string, string> = {};

let processed = 0;
let skipped = 0;
let apiErrors = 0;

for (const item of corpus) {
  if (item.type !== "command") continue;
  const cmd = item.title || item.id;
  const desc = item.description || "";
  const action = item.id.split(".")[1];
  if (!action) { skipped++; continue; }

  const prompt = promptTemplate
    .replace("${action}", action)
    .replace("${desc}", desc || "(no description)");

  try {
    const r = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: LM_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 100,
        reasoning_effort: "none",
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) { apiErrors++; continue; }
    const j = (await r.json()) as {
      choices: Array<{
        message: { content?: string; reasoning_content?: string };
      }>;
    };
    const msg = j.choices?.[0]?.message;
    const text = (msg?.content ?? msg?.reasoning_content ?? "").trim();

    const words = text
      .split(/[,|\n]+/)
      .map((w) =>
        w
          .replace(/^[-*]\s*/, "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
      )
      .filter((w) => w.length > 1 && !/^(the|and|or|for|to|in|of|by)$/.test(w));

    for (const w of words) {
      const cleaned = w.replace(/\s+/g, " ").trim();
      if (cleaned.length > 1 && !synonyms[cleaned]) synonyms[cleaned] = action;
    }
    processed++;
    if (processed % 10 === 0) process.stderr.write(`  ${processed}/${corpus.filter((c) => c.type === "command").length} commands\n`);
  } catch {
    apiErrors++;
  }
}

// ---- Filter generated synonyms ----------------------------------------------
// Remove self-references ("delete" -> "delete"), multi-word entries (won't
// match the per-token FTS5 tokenizer), and very short tokens.

const filtered: Record<string, string> = {};
for (const [word, action] of Object.entries(synonyms)) {
  if (word.includes(" ")) continue;
  if (word === action) continue;
  if (word.length < 2) continue;
  filtered[word] = action;
}

// ---- Write output -----------------------------------------------------------

const outPath = join(import.meta.dir, "..", "src", "generated", "synonyms.ts");
const code = [
  "// Auto-generated by scripts/generate-synonyms.ts -- do not edit manually.",
  `// Generated: ${new Date().toISOString()}`,
  `// ${Object.keys(filtered).length} synonym entries (filtered from ${Object.keys(synonyms).length} raw) across ${corpus.filter((c) => c.type === "command").length} commands`,
  "",
  "// Map: user word/phrase -> canonical command action verb",
  `export const GENERATED_SYNONYMS: Record<string, string> = ${JSON.stringify(filtered)};`,
].join("\n");

writeFileSync(outPath, code, "utf-8");
console.log(`✓ ${Object.keys(filtered).length} / ${Object.keys(synonyms).length} synonyms -> ${outPath}`);
