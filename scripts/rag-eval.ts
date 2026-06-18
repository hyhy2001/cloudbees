/**
 * RAG stress eval harness for `bee ask` — NOT part of the product build.
 *
 * Run:  bun run scripts/rag-eval.ts
 *
 * Phase A (fast, no LLM): generate thousands of queries from the real corpus +
 * a curated intent set, score retrieval (MRR / recall@5 / recall@10), and
 * bucket misses by cause (synonym gap / doc gap / ranking).
 *
 * Phase B (slow, LLM): sample ~50 queries, build the real prompt, ask the local
 * qwen2.5-coder server for an answer, then LLM-as-judge for grounding +
 * relevance. Skipped automatically when the server is unreachable.
 *
 * Output: console summary + rag-eval-report.md (gitignored) ranking the worst
 * queries so doc/synonym fixes are obvious.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { Command } from "commander";

import { setDbPath, initDb } from "../src/core/db/connection";
import { initPlugins } from "../src/registry/index";
import {
  buildCorpus,
  searchDocs,
  buildMatchExpr,
  expandToken,
  type DocItem,
} from "../src/plugins/docs/corpus";
import { buildPrompt } from "../src/plugins/docs/context";

// ─── Config ────────────────────────────────────────────────────────────────

const LM_URL = process.env.BEE_LM_URL ?? "http://127.0.0.1:11434";
const LM_TIMEOUT_MS = 10_000;
const PHASE_B_SAMPLE = 50;
const REPORT_PATH = join(import.meta.dir, "..", "rag-eval-report.md");

// ─── Corpus bootstrap (mirrors tests/docs-rag-stress.test.ts:33-47) ──────────

async function bootstrapCorpus(): Promise<DocItem[]> {
  const tmpDb = join(tmpdir(), `bee-rag-eval-${process.pid}.db`);
  setDbPath(tmpDb);
  initDb(tmpDb);
  const program = new Command("bee");
  program.exitOverride();
  await initPlugins(program);
  return buildCorpus(program);
}

// ─── Stopwords (mirror corpus.ts for query-token extraction) ─────────────────

const STOP = new Set([
  "a","an","the","is","it","its","be","are","was","were","been","being",
  "have","has","had","do","does","did","doing","will","would","could",
  "should","may","might","shall","can","need","dare","ought","used",
  "i","me","my","we","our","you","your","he","she","they","them","their",
  "this","that","these","those","what","which","who","whom","whose",
  "how","why","when","where","if","then","else","so","as","at","by",
  "for","from","in","into","of","on","or","and","but","not","no","nor",
  "to","up","out","with","about","after","before","between","through",
  "during","without","within","against","along","across","behind","beyond",
  "down","off","over","under","above","below","per","via",
]);

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

// ─── Query generation ────────────────────────────────────────────────────────

interface EvalQuery {
  query: string;
  /**
   * What we expect to retrieve.
   *  - id:         exactly this command/chunk id (commands).
   *  - source:     a source whose label contains this substring (curated concepts).
   *  - any-source: ANY of these sources (heading/body text shared across files —
   *                a one-word query like "list" cannot surface every file with a
   *                "## list" heading in one top-10, so satisfying any is correct).
   */
  expect:
    | { kind: "id"; value: string }
    | { kind: "source"; value: string }
    | { kind: "any-source"; values: string[] };
  /** Where this query came from — used to bucket misses. */
  origin: "cmd-title" | "cmd-desc" | "doc-heading" | "doc-body" | "concept" | "generated";
}

const VERBS = [
  "create","make","add","new",
  "delete","remove","destroy","erase",
  "list","show","view","see",
  "run","trigger","launch","start","execute",
  "stop","kill","cancel","abort","terminate",
  "copy","clone","duplicate","move","rename",
  "update","track","untrack","get","fetch",
  "login","logout","signin","signout",
  "offline","online","disable","enable",
];
const NOUNS = ["job","build","node","agent","credential","secret","profile","controller","folder","pipeline"];
const FILLERS = ["", "how do i ", "how to ", "a ", "the ", "please ", "i want to ", "can i "];

// Curated concept / troubleshooting intents → expected source file substring.
const CONCEPT_QUERIES: [string, string][] = [
  ["what is a profile", "concepts"],
  ["what does mine mean", "concepts"],
  ["mine vs all", "concepts"],
  ["how does the cache work", "concepts"],
  ["what is a controller", "concepts"],
  ["403 unauthorized error", "troubleshooting"],
  ["not logged in error", "troubleshooting"],
  ["connection refused", "troubleshooting"],
  ["certificate error", "troubleshooting"],
  ["how do i get started", "getting-started"],
  ["first time setup", "getting-started"],
  ["environment variables", "env-vars"],
  ["set config via env", "env-vars"],
  ["keyboard navigation table", "tui"],
  ["tui global keys", "tui"],
  ["how to switch profile", "auth"],
  ["ssh node setup", "node"],
  ["availability mode demand", "node"],
  ["secret text credential", "cred"],
  ["controlled agents folders plus", "job"],
];

// Off-domain queries — NOT about bee/CloudBees. The relevance gate must reject
// these even when a coincidental token prefix-matches a doc ("delete my email
// account" hits `auth.delete` via "delete"). Phase C measures gate precision:
// how many off-domain queries the gate correctly returns ZERO hits for.
const OFF_DOMAIN_QUERIES: string[] = [
  "how do I cook pasta",
  "what is the capital of France",
  "tell me a joke",
  "write a python script",
  "delete my email account",
  "weather tomorrow",
  "translate hello to spanish",
  "play some music",
  "recommend a good movie",
  "what time is it in tokyo",
  "convert 10 dollars to euros",
  "how tall is mount everest",
  "send an email to my boss",
  "remind me to buy milk",
  "what is the meaning of life",
  "fix my car engine",
];

function generateQueries(corpus: DocItem[]): EvalQuery[] {
  const queries: EvalQuery[] = [];
  const commands = corpus.filter((d) => d.type === "command");
  const docs = corpus.filter((d) => d.type === "doc");

  // 1. Every command by its title words
  for (const cmd of commands) {
    const words = cmd.title.replace(/[<>[\]]/g, " ").split(/\s+/).filter((w) => w && w !== "bee");
    if (words.length === 0) continue;
    queries.push({ query: words.join(" "), expect: { kind: "id", value: cmd.id }, origin: "cmd-title" });
  }

  // 2. Every command by its description
  for (const cmd of commands) {
    if (!cmd.description) continue;
    queries.push({ query: cmd.description, expect: { kind: "id", value: cmd.id }, origin: "cmd-desc" });
  }

  // 3. Every doc chunk by heading — but a heading like "list" or "log" is shared
  //    across files. Group identical heading-queries and accept ANY originating
  //    source: requiring one specific file to win top-10 for a one-word query is
  //    unsatisfiable when 4 files carry the same heading.
  const byHeadingQuery = new Map<string, Set<string>>();
  for (const doc of docs) {
    const tokens = contentTokens(doc.title);
    if (tokens.length === 0) continue;
    const q = tokens.join(" ");
    (byHeadingQuery.get(q) ?? byHeadingQuery.set(q, new Set()).get(q)!).add(doc.source);
  }
  for (const [query, sources] of byHeadingQuery) {
    queries.push({ query, expect: { kind: "any-source", values: [...sources] }, origin: "doc-heading" });
  }

  // 4. Every doc chunk by first body phrase — same shared-text grouping.
  const byBodyQuery = new Map<string, Set<string>>();
  for (const doc of docs) {
    const tokens = contentTokens(doc.body).slice(0, 5);
    if (tokens.length < 3) continue;
    const q = tokens.join(" ");
    (byBodyQuery.get(q) ?? byBodyQuery.set(q, new Set()).get(q)!).add(doc.source);
  }
  for (const [query, sources] of byBodyQuery) {
    queries.push({ query, expect: { kind: "any-source", values: [...sources] }, origin: "doc-body" });
  }

  // 5. Curated concept questions
  for (const [q, src] of CONCEPT_QUERIES) {
    queries.push({ query: q, expect: { kind: "source", value: src }, origin: "concept" });
  }

  // 6. Generated verb×noun×filler — no fixed expectation (recall: must return >=1 hit)
  for (const v of VERBS) {
    for (const n of NOUNS) {
      for (const f of FILLERS) {
        queries.push({ query: `${f}${v} ${n}`, expect: { kind: "id", value: "" }, origin: "generated" });
      }
    }
  }

  return queries;
}

// ─── Phase A: retrieval scoring ───────────────────────────────────────────────

interface Scored {
  q: EvalQuery;
  rank: number; // 1-based rank of expected hit; 0 = miss; -1 = generated (recall-only)
  hitCount: number;
  cause?: "synonym-gap" | "doc-gap" | "ranking" | "empty";
}

/**
 * Does a hit satisfy the expectation? id is exact; source is a SUBSTRING match
 * because curated concept intents expect a file stem ("concepts") while the
 * corpus carries the full label ("concepts.md", "cli/auth.md"). Substring is
 * safe for doc-heading/doc-body too: their expected value IS the full source,
 * and a string contains itself.
 */
function matches(q: EvalQuery, h: DocItem): boolean {
  if (q.expect.kind === "id") return h.id === q.expect.value;
  if (q.expect.kind === "any-source") return q.expect.values.some((v) => h.source.includes(v));
  return h.source.includes(q.expect.value);
}

/** Is this a recall-only generated query (no fixed expectation)? */
function isRecallOnly(q: EvalQuery): boolean {
  return q.expect.kind === "id" && q.expect.value === "";
}

/** Human-readable expectation for the report. */
function fmtExpect(q: EvalQuery): string {
  return q.expect.kind === "any-source"
    ? `any-source=${q.expect.values.join("|")}`
    : `${q.expect.kind}=${q.expect.value}`;
}

function rankOf(q: EvalQuery, hits: DocItem[]): number {
  if (isRecallOnly(q)) return -1; // generated: recall-only
  for (let i = 0; i < hits.length; i++) {
    if (matches(q, hits[i]!)) return i + 1;
  }
  return 0; // miss
}

/**
 * Classify why a miss happened, to make fixes obvious:
 *  - empty:       match expr was empty (all stopwords) — query-gen artifact
 *  - synonym-gap: no query token expands to a token in the expected target
 *  - ranking:     expected target IS retrieved in a wider top-50 — just out-ranked
 *  - doc-gap:     expected target absent even from top-50 — nothing to retrieve
 */
function classifyMiss(q: EvalQuery, corpus: DocItem[]): Scored["cause"] {
  if (buildMatchExpr(q.query) === "") return "empty";

  const wide = searchDocs(q.query, corpus, 50);
  const present = wide.some((h) => matches(q, h));
  if (present) return "ranking";

  // Does any query token (after synonym expansion) appear in the expected target's text?
  const target = corpus.find((d) => matches(q, d));
  if (target) {
    const blob = `${target.title} ${target.description} ${target.body}`.toLowerCase();
    const tokens = q.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const expanded = new Set<string>();
    for (const t of tokens) { expanded.add(t); expanded.add(expandToken(t)); }
    const anyTokenInTarget = [...expanded].some((t) => t.length >= 2 && blob.includes(t));
    if (!anyTokenInTarget) return "synonym-gap";
  }
  return "doc-gap";
}

// ─── Phase C: relevance gate (precision vs recall) ───────────────────────────
//
// The gate (searchDocs({gate:true})) is meant to suppress off-domain queries
// that share an accidental token with the corpus, so the LM never sees garbage
// context. Two things must hold simultaneously:
//   - RECALL kept: on-domain queries still return their expected hit WITH the
//     gate on (the gate must not silently eat real matches).
//   - PRECISION gained: off-domain queries return ZERO gated hits (rejected).
// Phase C measures both against the curated on/off-domain sets.

interface GateResult {
  onKept: number;       // on-domain queries whose expected hit survives the gate
  onTotal: number;
  offRejected: number;  // off-domain queries reduced to zero gated hits
  offTotal: number;
  onLost: string[];     // on-domain queries the gate wrongly emptied
  offLeaked: { query: string; topId: string }[]; // off-domain that still passed
}

function runPhaseC(corpus: DocItem[]): GateResult {
  const r: GateResult = {
    onKept: 0, onTotal: 0, offRejected: 0, offTotal: 0, onLost: [], offLeaked: [],
  };

  // On-domain: reuse the curated concept intents (real user questions) plus a
  // handful of command-style phrasings. Expected target = source substring.
  const onDomain: [string, string][] = [
    ...CONCEPT_QUERIES,
    ["create a job", "job"],
    ["delete a node", "node"],
    ["create credential", "cred"],
    ["switch profile", "auth"],
  ];
  for (const [q, expectSrc] of onDomain) {
    r.onTotal++;
    const gated = searchDocs(q, corpus, 10, { gate: true });
    if (gated.some((h) => h.source.includes(expectSrc) || h.id.includes(expectSrc))) {
      r.onKept++;
    } else {
      r.onLost.push(q);
    }
  }

  // Off-domain: the gate should empty these. Any survivor is a precision leak.
  for (const q of OFF_DOMAIN_QUERIES) {
    r.offTotal++;
    const gated = searchDocs(q, corpus, 10, { gate: true });
    if (gated.length === 0) r.offRejected++;
    else r.offLeaked.push({ query: q, topId: gated[0]!.id });
  }

  return r;
}

function runPhaseA(corpus: DocItem[], queries: EvalQuery[]): Scored[] {
  const scored: Scored[] = [];
  for (const q of queries) {
    const hits = searchDocs(q.query, corpus, 10);
    const rank = rankOf(q, hits);
    const s: Scored = { q, rank, hitCount: hits.length };
    if (rank === 0) s.cause = classifyMiss(q, corpus);
    else if (rank === -1 && hits.length === 0) s.cause = "empty";
    scored.push(s);
  }
  return scored;
}

// ─── Phase B: answer quality via local LLM ─────────────────────────────────────

async function lmReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${LM_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function lmChat(messages: { role: string; content: string }[]): Promise<string> {
  const r = await fetch(`${LM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, temperature: 0, max_tokens: 256 }),
    signal: AbortSignal.timeout(LM_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`LM HTTP ${r.status}`);
  const j = (await r.json()) as { choices: { message: { content: string } }[] };
  return j.choices[0]?.message?.content ?? "";
}

interface Judged {
  query: string;
  answer: string;
  grounded: number; // 0-5
  relevant: number; // 0-5
  note: string;
  skipped?: boolean;
}

const JUDGE_SYSTEM =
  "You are evaluating a CLI help assistant's answer. You are given the CONTEXT it was shown " +
  "and its ANSWER. Score two axes 0-5:\n" +
  "GROUNDED: are all commands/flags in the answer actually present in the context? " +
  "(5 = fully grounded, 0 = invented commands/flags)\n" +
  "RELEVANT: does the answer address the question?\n" +
  'Reply with ONLY compact JSON: {"grounded":N,"relevant":N,"note":"<=12 words"}';

function pickPhaseBSample(scored: Scored[]): EvalQuery[] {
  // Cover each origin + ensure concept/troubleshooting present; bias toward
  // real intents (skip the synthetic generated bucket — recall-only, no answer signal).
  const pool = scored.map((s) => s.q).filter((q) => q.origin !== "generated");
  const byOrigin = new Map<string, EvalQuery[]>();
  for (const q of pool) {
    const arr = byOrigin.get(q.origin) ?? [];
    arr.push(q);
    byOrigin.set(q.origin, arr);
  }
  const sample: EvalQuery[] = [];
  const origins = [...byOrigin.keys()];
  let i = 0;
  while (sample.length < PHASE_B_SAMPLE && pool.length > 0) {
    const origin = origins[i % origins.length]!;
    const arr = byOrigin.get(origin)!;
    if (arr.length > 0) sample.push(arr.shift()!);
    i++;
    if (origins.every((o) => byOrigin.get(o)!.length === 0)) break;
  }
  return sample;
}

async function runPhaseB(corpus: DocItem[], sample: EvalQuery[]): Promise<Judged[]> {
  const results: Judged[] = [];
  for (const q of sample) {
    const hits = searchDocs(q.query, corpus, 5);
    const prompt = buildPrompt(q.query, hits);
    try {
      const answer = await lmChat([{ role: "user", content: prompt }]);
      const judgeRaw = await lmChat([
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: `CONTEXT:\n${prompt}\n\nANSWER:\n${answer}` },
      ]);
      const m = judgeRaw.match(/\{.*\}/s);
      const parsed = m ? (JSON.parse(m[0]) as { grounded: number; relevant: number; note: string }) : null;
      results.push({
        query: q.query,
        answer: answer.slice(0, 300),
        grounded: parsed?.grounded ?? -1,
        relevant: parsed?.relevant ?? -1,
        note: parsed?.note ?? "judge parse failed",
      });
    } catch (err) {
      results.push({
        query: q.query,
        answer: "",
        grounded: -1,
        relevant: -1,
        note: String(err instanceof Error ? err.message : err),
        skipped: true,
      });
    }
  }
  return results;
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function buildReport(scored: Scored[], judged: Judged[], lmUp: boolean, gate: GateResult): string {
  // Phase A aggregates over queries with a fixed expectation (exclude generated recall-only).
  const targeted = scored.filter((s) => s.rank !== -1);
  const found = targeted.filter((s) => s.rank > 0);
  const recall5 = targeted.filter((s) => s.rank > 0 && s.rank <= 5).length / (targeted.length || 1);
  const recall10 = found.length / (targeted.length || 1);
  const mrr = mean(targeted.map((s) => (s.rank > 0 ? 1 / s.rank : 0)));

  const generated = scored.filter((s) => s.rank === -1);
  const emptyGenerated = generated.filter((s) => s.hitCount === 0);

  const misses = targeted.filter((s) => s.rank === 0);
  const byCause = new Map<string, Scored[]>();
  for (const m of misses) {
    const c = m.cause ?? "unknown";
    const arr = byCause.get(c) ?? [];
    arr.push(m);
    byCause.set(c, arr);
  }

  const L: string[] = [];
  L.push("# RAG Eval Report");
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push("");
  L.push("## Phase A — retrieval (no LLM)");
  L.push("");
  L.push(`- Targeted queries: **${targeted.length}**`);
  L.push(`- recall@5:  **${(recall5 * 100).toFixed(1)}%**`);
  L.push(`- recall@10: **${(recall10 * 100).toFixed(1)}%**`);
  L.push(`- MRR:       **${mrr.toFixed(3)}**`);
  L.push(`- Generated (recall-only) queries: ${generated.length}, returned-zero-hits: **${emptyGenerated.length}**`);
  L.push("");
  L.push("### Misses by cause");
  L.push("");
  for (const [cause, arr] of [...byCause.entries()].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`- **${cause}**: ${arr.length}`);
  }
  L.push("");

  for (const [cause, arr] of [...byCause.entries()].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`#### ${cause} (${arr.length})`);
    L.push("");
    for (const m of arr.slice(0, 30)) {
      L.push(`- \`${m.q.query}\` → expected ${fmtExpect(m.q)} (origin: ${m.q.origin})`);
    }
    if (arr.length > 30) L.push(`- … and ${arr.length - 30} more`);
    L.push("");
  }

  // Worst ranked (present but deep)
  const deep = found.filter((s) => s.rank >= 6).sort((a, b) => b.rank - a.rank);
  if (deep.length) {
    L.push("### Retrieved but ranked deep (>=6)");
    L.push("");
    for (const s of deep.slice(0, 25)) {
      L.push(`- rank ${s.rank}: \`${s.q.query}\` → ${fmtExpect(s.q)}`);
    }
    L.push("");
  }

  // Empty generated queries — these are user-plausible phrasings returning nothing
  if (emptyGenerated.length) {
    L.push("### Generated queries returning ZERO hits");
    L.push("");
    for (const s of emptyGenerated.slice(0, 40)) {
      L.push(`- \`${s.q.query}\``);
    }
    if (emptyGenerated.length > 40) L.push(`- … and ${emptyGenerated.length - 40} more`);
    L.push("");
  }

  L.push("## Phase C — relevance gate (precision)");
  L.push("");
  L.push(`- On-domain kept:  **${gate.onKept}/${gate.onTotal}** (gate must not empty real queries)`);
  L.push(`- Off-domain rejected: **${gate.offRejected}/${gate.offTotal}** (gate should empty garbage)`);
  L.push("");
  if (gate.onLost.length) {
    L.push("### On-domain WRONGLY emptied by gate (recall loss)");
    L.push("");
    for (const q of gate.onLost) L.push(`- \`${q}\``);
    L.push("");
  }
  if (gate.offLeaked.length) {
    L.push("### Off-domain leaked past gate (precision miss)");
    L.push("");
    for (const l of gate.offLeaked) L.push(`- \`${l.query}\` → ${l.topId}`);
    L.push("");
  }

  L.push("## Phase B — answer quality (LLM)");
  L.push("");
  if (!lmUp) {
    L.push("_Skipped — LM server unreachable at " + LM_URL + "._");
    L.push("");
  } else {
    const valid = judged.filter((j) => !j.skipped && j.grounded >= 0);
    L.push(`- Sampled: ${judged.length}, judged: ${valid.length}, skipped/failed: ${judged.length - valid.length}`);
    L.push(`- Mean grounded: **${mean(valid.map((j) => j.grounded)).toFixed(2)}** / 5`);
    L.push(`- Mean relevant: **${mean(valid.map((j) => j.relevant)).toFixed(2)}** / 5`);
    L.push("");
    const worst = valid.slice().sort((a, b) => a.grounded + a.relevant - (b.grounded + b.relevant)).slice(0, 15);
    L.push("### Lowest-scoring answers");
    L.push("");
    for (const j of worst) {
      L.push(`- \`${j.query}\` — grounded ${j.grounded}, relevant ${j.relevant} — ${j.note}`);
    }
    L.push("");
  }

  return L.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Bootstrapping real corpus…");
  const corpus = await bootstrapCorpus();
  console.log(`Corpus: ${corpus.length} items (${corpus.filter((d) => d.type === "command").length} commands, ${corpus.filter((d) => d.type === "doc").length} doc chunks)`);

  const queries = generateQueries(corpus);
  console.log(`Generated ${queries.length} queries. Running Phase A…`);
  const scored = runPhaseA(corpus, queries);

  const targeted = scored.filter((s) => s.rank !== -1);
  const found = targeted.filter((s) => s.rank > 0).length;
  console.log(`Phase A done: ${found}/${targeted.length} targeted queries found in top-10.`);

  const gate = runPhaseC(corpus);
  console.log(`Phase C (gate) done: on-domain kept ${gate.onKept}/${gate.onTotal}, off-domain rejected ${gate.offRejected}/${gate.offTotal}.`);

  const lmUp = await lmReachable();
  let judged: Judged[] = [];
  if (lmUp) {
    const sample = pickPhaseBSample(scored);
    console.log(`LM up at ${LM_URL}. Running Phase B on ${sample.length} samples (~${(sample.length * 3.4).toFixed(0)}s)…`);
    judged = await runPhaseB(corpus, sample);
    console.log("Phase B done.");
  } else {
    console.log(`LM unreachable at ${LM_URL} — skipping Phase B.`);
  }

  const report = buildReport(scored, judged, lmUp, gate);
  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
