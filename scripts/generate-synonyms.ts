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
  chatPath?: string;
  embeddingPath?: string;
  clientId?: string;
  clientSecret?: string;
  CB_DATABRICK_URL?: string;
  CB_API_KEY?: string;
  CB_LM_MODEL?: string;
  CB_CHAT_PATH?: string;
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
const CHAT_PATH = lmFile.chatPath ?? lmFile.CB_CHAT_PATH ?? process.env["CB_CHAT_PATH"] ?? "/v1/chat/completions";
const LM_API_KEY = lmFile.apiKey ?? lmFile.CB_API_KEY ?? process.env["CB_API_KEY"] ?? "";
const CLI_ID = lmFile.clientId ?? lmFile.CB_CLIENT_ID ?? process.env["CB_CLIENT_ID"] ?? "";
const CLI_SEC = lmFile.clientSecret ?? lmFile.CB_CLIENT_SECRET ?? process.env["CB_CLIENT_SECRET"] ?? "";
const LM_MODEL = lmFile.model ?? lmFile.CB_LM_MODEL ?? process.env["CB_LM_MODEL"] ?? "oc/deepseek-v4-flash-free";
const CHAT_ENDPOINT = BASE_URL ? `${BASE_URL.replace(/\/+$/, "")}${CHAT_PATH}` : "";

if (!CHAT_ENDPOINT) {
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

// Quick connectivity: check endpoint is reachable.
// We don't exit on HTTP errors (400/401/404) — the per-command loop handles them.
// Only hard network failures (unreachable host, timeout) cause a skip.
try {
  const health = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: LM_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 1, temperature: 0 }),
    signal: AbortSignal.timeout(10000),
  });
  if (health.status === 404) {
    console.error(`Chat endpoint at ${CHAT_ENDPOINT} returned 404 — synonym generation skipped.`);
    process.exit(1);
  }
} catch {
  console.error(`Chat endpoint at ${CHAT_ENDPOINT} is unreachable — skipping synonym generation.`);
  process.exit(1);
}

// ---- Build corpus -----------------------------------------------------------

const program = new Command("bee");
program.exitOverride();
await initPlugins(program);
const corpus = buildCorpus(program);

// ---- Generate synonyms for each command -------------------------------------

const prompts = [
  [
    "You are a CLI synonym generator.",
    "For the command below, list 10-15 alternative single words (verbs or short nouns) a user might use instead.",
    "Command action: ${action}",
    "Command description: ${desc}",
    "",
    "Return ONLY comma-separated lowercase words, no punctuation or explanation:",
  ].join("\n"),
  [
    "List 10-15 MORE single-word alternatives for this CLI command — abbreviations, informal terms, or synonyms NOT in your previous answer.",
    "Command action: ${action}",
    "Command description: ${desc}",
    "",
    "Return ONLY comma-separated lowercase words:",
  ].join("\n"),
];

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

  for (const template of prompts) {
    const prompt = template
      .replace("${action}", action)
      .replace("${desc}", desc || "(no description)");

    try {
      const r = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: LM_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 200,
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
    } catch {
      apiErrors++;
    }
  }
  processed++;
  if (processed % 10 === 0) process.stderr.write(`  ${processed}/${corpus.filter((c) => c.type === "command").length} commands\n`);
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

// ---- Generate flag synonyms ------------------------------------------------
// Collect unique flags from command body (flag table text).
const flagSet = new Map<string, { cmds: string[]; desc: string }>();
for (const c of corpus) {
  if (c.type !== "command") continue;
  const lines = (c.body || "").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*(--[\w-]+)\s+(.+)$/);
    if (m) {
      const flag = m[1];
      const desc = m[2].trim();
      if (!flagSet.has(flag)) flagSet.set(flag, { cmds: [], desc });
      flagSet.get(flag)!.cmds.push(c.id);
    }
  }
}

const flagSynonyms: Record<string, { flags: string[]; example: string }> = {};
let flagProcessed = 0;

for (const [flag, { cmds, desc }] of flagSet) {
  flagProcessed++;
  const cmdList = [...new Set(cmds.map((c) => c.split(".").slice(0, 2).join(".")))].slice(0, 5);
  const flagPrompt = [
    "You are a CLI command flag synonym generator.",
    `For the CLI flag "${flag}" with description "${desc}" used in commands: ${cmdList.join(", ")}`,
    "List 3-5 alternative natural-language phrases users might say instead, plus one real usage example.",
    "",
    "Format: phrase1|phrase2|phrase3||e.g. bee <command> --flag value",
    "Return ONLY this format, no extra text:",
  ].join("\n");

  process.stderr.write(`  flag ${flagProcessed}/${flagSet.size}: ${flag}\n`);
  try {
    const r = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: LM_MODEL,
        messages: [{ role: "user", content: flagPrompt }],
        temperature: 0,
        max_tokens: 150,
        reasoning_effort: "none",
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) continue;
    const j = (await r.json()) as { choices: Array<{ message: { content?: string } }> };
    const text = (j.choices?.[0]?.message?.content ?? "").trim();
    const parts = text.split("||");
    const phrases = (parts[0] || "").split("|").map((p) => p.trim().toLowerCase()).filter(Boolean);
    const example = (parts[1] || "").trim();
    for (const phrase of phrases) {
      if (phrase.length > 2 && !flagSynonyms[phrase]) {
        flagSynonyms[phrase] = { flags: [flag], example };
      }
    }
  } catch { /* skip this flag */ }
}

// ---- Write output -----------------------------------------------------------

const outPath = join(import.meta.dir, "..", "src", "generated", "synonyms.ts");
const code = [
  "// Auto-generated by scripts/generate-synonyms.ts -- do not edit manually.",
  `// Generated: ${new Date().toISOString()}`,
  `// ${Object.keys(filtered).length} synonym entries (filtered from ${Object.keys(synonyms).length} raw) across ${corpus.filter((c) => c.type === "command").length} commands`,
  `// ${Object.keys(flagSynonyms).length} flag synonym entries across ${flagSet.size} flags`,
  "",
  "// Map: user word/phrase -> canonical command action verb",
  `export const GENERATED_SYNONYMS: Record<string, string> = ${JSON.stringify(filtered)};`,
  "",
  "// Map: natural-language phrase -> flag(s) + usage example",
  `export const GENERATED_FLAG_SYNONYMS: Record<string, { flags: string[]; example: string }> = ${JSON.stringify(flagSynonyms)};`,
].join("\n");

writeFileSync(outPath, code, "utf-8");
console.log(`✓ ${Object.keys(filtered).length} synonym entries + ${Object.keys(flagSynonyms).length} flag synonyms -> ${outPath}`);
