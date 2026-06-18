/**
 * Comprehensive benchmark for `bee ask` — BM25 retrieval quality + LLM answer quality.
 *
 * Run:  bun run scripts/benchmark.ts
 *       bun run scripts/benchmark.ts --no-llm      # skip LLM phase
 *       bun run scripts/benchmark.ts --lm-url http://127.0.0.1:11434
 *
 * Phase A — BM25 retrieval:
 *   Hand-curated ground-truth queries, each with an expected command/help-fact id.
 *   Metrics: Recall@1, Recall@3, Recall@5, MRR. Breakdown by query type.
 *
 * Phase B — LLM answer quality:
 *   Role-separated prompt (SYSTEM_PROMPT + buildUserPrompt). Rule-based scoring —
 *   NO self-judge. Measures: hallucination rate, correct_command, has_flag.
 *
 * Output: console table + benchmark-report.md (gitignored).
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { Command } from "commander";

import { setDbPath, initDb } from "../src/core/db/connection";
import { initPlugins } from "../src/registry/index";
import { buildCorpus, searchDocs, type DocItem } from "../src/plugins/docs/corpus";
import { SYSTEM_PROMPT, buildUserPrompt } from "../src/plugins/docs/context";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const NO_LLM = args.includes("--no-llm");
const LM_URL_IDX = args.indexOf("--lm-url");
const LM_URL = LM_URL_IDX >= 0 ? (args[LM_URL_IDX + 1] ?? "http://127.0.0.1:11434") : "http://127.0.0.1:11434";
const LM_TIMEOUT_MS = 30_000;
const REPORT_PATH = join(import.meta.dir, "..", "benchmark-report.md");

// ─── Corpus bootstrap ─────────────────────────────────────────────────────────

async function bootstrapCorpus(): Promise<DocItem[]> {
  const tmpDb = join(tmpdir(), `bee-benchmark-${process.pid}.db`);
  setDbPath(tmpDb);
  initDb(tmpDb);
  const program = new Command("bee");
  program.exitOverride();
  await initPlugins(program);
  return buildCorpus(program);
}

// ─── Ground-truth dataset ─────────────────────────────────────────────────────
//
// Each entry: (query, expectedId, queryType, mustContainFlag?)
//
// queryType groups:
//   "exact"        — query words appear verbatim in command title
//   "natural"      — natural-language paraphrase, no keyword overlap with title
//   "concept"      — asks about a concept, expected hit is a help-fact
//   "troubleshoot" — troubleshooting / error query
//   "flag"         — specifically asks about a flag, answer must mention it
//   "cross-plugin" — query spans multiple plugins (e.g. "list everything")

export interface GroundTruth {
  query: string;
  expectedId: string;
  /** Human-readable label for what the expected command does. */
  label: string;
  queryType: "exact" | "natural" | "concept" | "troubleshoot" | "flag" | "cross-plugin";
  /** If set, the LLM answer MUST contain this flag string to pass has_flag. */
  mustContainFlag?: string;
}

export const GROUND_TRUTH: GroundTruth[] = [
  // ── exact: title words in query ────────────────────────────────────────────
  { query: "job run",              expectedId: "job.run",            label: "bee job run",             queryType: "exact" },
  { query: "job stop",             expectedId: "job.stop",           label: "bee job stop",            queryType: "exact" },
  { query: "job list",             expectedId: "job.list",           label: "bee job list",            queryType: "exact" },
  { query: "job log",              expectedId: "job.log",            label: "bee job log",             queryType: "exact" },
  { query: "job history",          expectedId: "job.history",        label: "bee job history",         queryType: "exact" },
  { query: "job get",              expectedId: "job.get",            label: "bee job get",             queryType: "exact" },
  { query: "job delete",           expectedId: "job.delete",         label: "bee job delete",          queryType: "exact" },
  { query: "node list",            expectedId: "node.list",          label: "bee node list",           queryType: "exact" },
  { query: "node create",          expectedId: "node.create",        label: "bee node create",         queryType: "exact" },
  { query: "node delete",          expectedId: "node.delete",        label: "bee node delete",         queryType: "exact" },
  { query: "node offline",         expectedId: "node.offline",       label: "bee node offline",        queryType: "exact" },
  { query: "node online",          expectedId: "node.online",        label: "bee node online",         queryType: "exact" },
  { query: "node get",             expectedId: "node.get",           label: "bee node get",            queryType: "exact" },
  { query: "cred list",            expectedId: "cred.list",          label: "bee cred list",           queryType: "exact" },
  { query: "cred create",          expectedId: "cred.create",        label: "bee cred create",         queryType: "exact" },
  { query: "cred delete",          expectedId: "cred.delete",        label: "bee cred delete",         queryType: "exact" },
  { query: "cred update",          expectedId: "cred.update",        label: "bee cred update",         queryType: "exact" },
  { query: "auth login",           expectedId: "auth.login",         label: "bee auth login",          queryType: "exact" },
  { query: "auth logout",          expectedId: "auth.logout",        label: "bee auth logout",         queryType: "exact" },
  { query: "auth profiles",        expectedId: "auth.profiles",      label: "bee auth profiles",       queryType: "exact" },
  { query: "controller list",      expectedId: "controller.list",    label: "bee controller list",     queryType: "exact" },
  { query: "controller select",    expectedId: "controller.select",  label: "bee controller select",   queryType: "exact" },

  // ── natural: paraphrase, no keyword overlap with command title ─────────────
  { query: "trigger a build",              expectedId: "job.run",        label: "bee job run",         queryType: "natural" },
  { query: "execute a pipeline",           expectedId: "job.run",        label: "bee job run",         queryType: "natural" },
  { query: "start a jenkins job",          expectedId: "job.run",        label: "bee job run",         queryType: "natural" },
  { query: "cancel a running build",       expectedId: "job.stop",       label: "bee job stop",        queryType: "natural" },
  { query: "abort the current build",      expectedId: "job.stop",       label: "bee job stop",        queryType: "natural" },
  { query: "see build output",             expectedId: "job.log",        label: "bee job log",         queryType: "natural" },
  { query: "follow console output",        expectedId: "job.log",        label: "bee job log",         queryType: "natural" },
  { query: "past builds for a job",        expectedId: "job.history",    label: "bee job history",     queryType: "natural" },
  { query: "remove a job",                 expectedId: "job.delete",     label: "bee job delete",      queryType: "natural" },
  { query: "add an agent",                 expectedId: "node.create",    label: "bee node create",     queryType: "natural" },
  { query: "take an agent offline",        expectedId: "node.offline",   label: "bee node offline",    queryType: "natural" },
  { query: "bring agent back online",      expectedId: "node.online",    label: "bee node online",     queryType: "natural" },
  { query: "remove an agent",              expectedId: "node.delete",    label: "bee node delete",     queryType: "natural" },
  { query: "store a secret",               expectedId: "cred.create",    label: "bee cred create",     queryType: "natural" },
  { query: "rotate api key",               expectedId: "cred.update",    label: "bee cred update",     queryType: "natural" },
  { query: "remove a stored credential",   expectedId: "cred.delete",    label: "bee cred delete",     queryType: "natural" },
  { query: "sign in to cloudbees",         expectedId: "auth.login",     label: "bee auth login",      queryType: "natural" },
  { query: "log out from server",          expectedId: "auth.logout",    label: "bee auth logout",     queryType: "natural" },
  { query: "show saved accounts",          expectedId: "auth.profiles",  label: "bee auth profiles",   queryType: "natural" },
  { query: "switch jenkins server",        expectedId: "controller.select", label: "bee controller select", queryType: "natural" },

  // ── concept: help-fact questions ───────────────────────────────────────────
  { query: "what is a profile",                     expectedId: "concept.profile",           label: "concept: profile",           queryType: "concept" },
  { query: "what is a controller",                  expectedId: "concept.controller",        label: "concept: controller",        queryType: "concept" },
  { query: "what does --all flag do",               expectedId: "concept.mine-vs-all",       label: "concept: mine vs all",       queryType: "concept" },
  { query: "mine vs all list",                      expectedId: "concept.mine-vs-all",       label: "concept: mine vs all",       queryType: "concept" },
  { query: "credential system store vs user store", expectedId: "concept.credential-store",  label: "concept: cred store",        queryType: "concept" },
  { query: "what does node offline mean",           expectedId: "concept.node-offline",      label: "concept: node offline",      queryType: "concept" },
  { query: "how to run job with parameters",        expectedId: "concept.build-params",      label: "concept: build params",      queryType: "concept" },
  { query: "what are node labels",                  expectedId: "concept.node-labels",       label: "concept: node labels",       queryType: "concept" },
  { query: "how do folders work",                   expectedId: "concept.folders",           label: "concept: folders",           queryType: "concept" },
  { query: "ssh launcher vs jnlp launcher",         expectedId: "concept.agent-launcher",    label: "concept: agent launcher",    queryType: "concept" },
  { query: "what is controlled agent",              expectedId: "concept.controlled-agent",  label: "concept: controlled agent",  queryType: "concept" },
  { query: "what types of credentials does bee support", expectedId: "concept.credential-types", label: "concept: cred types",   queryType: "concept" },

  // ── troubleshoot ───────────────────────────────────────────────────────────
  { query: "403 forbidden error",                   expectedId: "troubleshooting.403",           label: "troubleshoot: 403",         queryType: "troubleshoot" },
  { query: "getting 403 access denied",             expectedId: "troubleshooting.403",           label: "troubleshoot: 403",         queryType: "troubleshoot" },
  { query: "login failed bad token",                expectedId: "troubleshooting.login",         label: "troubleshoot: login",       queryType: "troubleshoot" },
  { query: "token expired cannot login",            expectedId: "troubleshooting.login",         label: "troubleshoot: login",       queryType: "troubleshoot" },
  { query: "agent keeps disconnecting",             expectedId: "troubleshooting.node-connect",  label: "troubleshoot: node connect",queryType: "troubleshoot" },
  { query: "node unreachable cannot connect",       expectedId: "troubleshooting.node-connect",  label: "troubleshoot: node connect",queryType: "troubleshoot" },
  { query: "bee ask finds no results",              expectedId: "troubleshooting.ask-no-results",label: "troubleshoot: ask empty",   queryType: "troubleshoot" },

  // ── flag: answer must mention a specific flag ──────────────────────────────
  { query: "wait for build to finish",        expectedId: "job.run",    label: "bee job run --wait",        queryType: "flag", mustContainFlag: "--wait" },
  { query: "follow logs in real time",        expectedId: "job.log",    label: "bee job log --follow",      queryType: "flag", mustContainFlag: "--follow" },
  { query: "run job with parameter values",   expectedId: "job.run",    label: "bee job run -p",            queryType: "flag", mustContainFlag: "-p" },
  { query: "list all jobs not just mine",     expectedId: "job.list",   label: "bee job list --all",        queryType: "flag", mustContainFlag: "--all" },
  { query: "login to a specific profile",     expectedId: "auth.login", label: "bee auth login --profile",  queryType: "flag", mustContainFlag: "--profile" },

  // ── cross-plugin: involves multiple command groups ─────────────────────────
  { query: "show everything on the server",       expectedId: "job.list",   label: "list commands",     queryType: "cross-plugin" },
  { query: "what commands are available",         expectedId: "job.list",   label: "list commands",     queryType: "cross-plugin" },
  { query: "manage jenkins nodes and jobs",       expectedId: "node.list",  label: "node/job list",     queryType: "cross-plugin" },
];

// ─── Phase A: BM25 retrieval scoring ─────────────────────────────────────────

export interface BM25Result {
  gt: GroundTruth;
  rank: number;       // 1-based position of expected hit; 0 = not in top-10
  hitCount: number;   // number of results returned
  topId: string;      // id of rank-1 result (or "" if empty)
}

function runPhaseA(corpus: DocItem[]): BM25Result[] {
  return GROUND_TRUTH.map((gt) => {
    const hits = searchDocs(gt.query, corpus, 10);
    const idx = hits.findIndex((h) => h.id === gt.expectedId);
    return {
      gt,
      rank: idx >= 0 ? idx + 1 : 0,
      hitCount: hits.length,
      topId: hits[0]?.id ?? "",
    };
  });
}

function phaseAStats(results: BM25Result[]) {
  const byType = new Map<string, BM25Result[]>();
  for (const r of results) {
    const arr = byType.get(r.gt.queryType) ?? [];
    arr.push(r);
    byType.set(r.gt.queryType, arr);
  }

  function stats(rs: BM25Result[]) {
    const n = rs.length;
    const r1  = rs.filter((r) => r.rank === 1).length;
    const r3  = rs.filter((r) => r.rank > 0 && r.rank <= 3).length;
    const r5  = rs.filter((r) => r.rank > 0 && r.rank <= 5).length;
    const mrr = rs.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / (n || 1);
    return { n, r1, r3, r5, mrr };
  }

  return { overall: stats(results), byType };
}


// ─── Phase B: LLM answer quality — rule-based scoring ────────────────────────
//
// NO self-judge. Scoring is purely rule-based on the answer text:
//
//   hallucinated     — answer mentions a `bee X` command that was NOT in the
//                      BM25 context (invented command). 1 = hallucinated, 0 = clean.
//   correct_command  — answer mentions the expected command id's title token
//                      (e.g. "job run" for id "job.run"). 1 = correct, 0 = wrong.
//   has_flag         — if mustContainFlag is set, answer mentions that flag.
//                      1 = present, 0 = missing. null if no flag required.
//   refused          — answer contains "no info available" / "I only help"
//                      when a real answer was expected. 1 = wrong refusal.

export interface LLMResult {
  gt: GroundTruth;
  answer: string;
  hallucinated: 0 | 1;
  correct_command: 0 | 1;
  has_flag: 0 | 1 | null;
  refused: 0 | 1;
  skipped: boolean;
  error?: string;
}

async function lmReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${LM_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function lmChat(
  system: string,
  user: string,
): Promise<string> {
  const r = await fetch(`${LM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user },
      ],
      temperature: 0,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(LM_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`LM HTTP ${r.status}`);
  const j = (await r.json()) as { choices: { message: { content: string } }[] };
  return j.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Extract all `bee <sub> <cmd>` command tokens mentioned in the answer.
 * Matches "bee job run", "bee cred update", "bee auth login", etc.
 */
function extractMentionedCommands(text: string): string[] {
  const matches = text.matchAll(/\bbee\s+([a-z]+(?:\s+[a-z]+)?)/gi);
  return [...matches].map((m) => m[0]!.toLowerCase().trim());
}

/**
 * Collect all command titles that appear in a BM25 hit list.
 * Only "command" type items carry a canonical `bee X Y` title.
 */
function contextCommandTitles(hits: DocItem[]): Set<string> {
  const s = new Set<string>();
  for (const h of hits) {
    if (h.type === "command") {
      s.add(h.title.toLowerCase().replace(/[<>[\]]/g, "").replace(/\s+/g, " ").trim());
    }
    // Help-fact bodies embed "bee X" lines — also extract those
    for (const line of h.body.split("\n")) {
      const t = line.trim().toLowerCase();
      if (t.startsWith("bee ")) s.add(t.replace(/[<>[\]]/g, "").replace(/\s+/g, " ").trim());
    }
  }
  return s;
}

/**
 * Does `cmd` (a token like "bee job run") appear in contextTitles as a prefix match?
 * We use prefix because "bee job run" in context matches "bee job run <name>" title.
 */
function commandInContext(cmd: string, contextTitles: Set<string>): boolean {
  const norm = cmd.replace(/[<>[\]]/g, "").replace(/\s+/g, " ").trim();
  for (const ct of contextTitles) {
    if (ct.startsWith(norm) || norm.startsWith(ct)) return true;
  }
  return false;
}

/**
 * Score one LLM answer against ground truth — rule-based only.
 */
function scoreAnswer(
  gt: GroundTruth,
  answer: string,
  hits: DocItem[],
): Pick<LLMResult, "hallucinated" | "correct_command" | "has_flag" | "refused"> {
  const contextTitles = contextCommandTitles(hits);
  const mentioned = extractMentionedCommands(answer);

  // hallucinated: any mentioned command NOT in context
  const hallucinated: 0 | 1 = mentioned.some((cmd) => !commandInContext(cmd, contextTitles)) ? 1 : 0;

  const answerLower = answer.toLowerCase();

  // correct_command:
  //  - For command-type queries (exact / natural / flag): answer must mention the specific
  //    command title, e.g. "job.run" → answer contains "bee job run".
  //  - For concept/troubleshoot queries: the expected id is a help-fact (e.g. "concept.profile"),
  //    not a real command. Instead, check that the answer mentions AT LEAST ONE command that
  //    appears in the BM25 context. A good answer to "what is a profile" should cite
  //    "bee auth profiles", "bee auth login" etc. — all of which are in the context.
  let correct_command: 0 | 1;
  if (gt.queryType === "concept" || gt.queryType === "troubleshoot") {
    // Pass if answer mentions any context command AND is not empty
    correct_command =
      mentioned.length > 0 && mentioned.some((cmd) => commandInContext(cmd, contextTitles)) ? 1 : 0;
  } else {
    // Pass if answer explicitly mentions the expected command
    const expectedTitle = `bee ${gt.expectedId.replace(".", " ")}`;
    correct_command = answerLower.includes(expectedTitle) ? 1 : 0;
  }

  // has_flag: only scored when mustContainFlag is set
  const has_flag: 0 | 1 | null =
    gt.mustContainFlag != null
      ? (answerLower.includes(gt.mustContainFlag.toLowerCase()) ? 1 : 0)
      : null;

  // refused: model said "no info" or "I only help" when a real answer is expected
  const refused: 0 | 1 =
    /no info available|i only help|not related to bee/i.test(answer) ? 1 : 0;

  return { hallucinated, correct_command, has_flag, refused };
}

async function runPhaseB(corpus: DocItem[]): Promise<LLMResult[]> {
  const results: LLMResult[] = [];

  // Only test ground-truth entries that have a real LLM signal: concept, troubleshoot, flag, natural.
  // "exact" queries are too mechanical to measure LLM quality meaningfully.
  const sample = GROUND_TRUTH.filter((gt) =>
    ["natural", "concept", "troubleshoot", "flag"].includes(gt.queryType),
  );

  process.stdout.write(`  Running ${sample.length} LLM queries`);

  for (const gt of sample) {
    const hits = searchDocs(gt.query, corpus, 5);
    const userPrompt = buildUserPrompt(gt.query, hits);

    try {
      const answer = await lmChat(SYSTEM_PROMPT, userPrompt);
      const scores = scoreAnswer(gt, answer, hits);
      results.push({ gt, answer, ...scores, skipped: false });
      process.stdout.write(".");
    } catch (err) {
      results.push({
        gt,
        answer: "",
        hallucinated: 0,
        correct_command: 0,
        has_flag: null,
        refused: 0,
        skipped: true,
        error: String(err instanceof Error ? err.message : err),
      });
      process.stdout.write("E");
    }
  }

  process.stdout.write("\n");
  return results;
}


// ─── Reporting ────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d === 0 ? "N/A" : `${((n / d) * 100).toFixed(1)}%`;
}

function pad(s: string | number, w: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(w) : str.padEnd(w);
}

function buildReport(
  corpus: DocItem[],
  bm25: BM25Result[],
  llm: LLMResult[],
  lmUp: boolean,
): string {
  const L: string[] = [];

  L.push("# bee ask Benchmark Report");
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push(`Corpus: ${corpus.length} items (${corpus.filter((d) => d.type === "command").length} commands, ${corpus.filter((d) => d.type === "doc").length} doc chunks)`);
  L.push(`Ground-truth queries: ${GROUND_TRUTH.length}`);
  L.push("");

  // ── Phase A summary ──────────────────────────────────────────────────────
  L.push("## Phase A — BM25 Retrieval");
  L.push("");

  const { overall, byType } = phaseAStats(bm25);
  L.push("### Overall");
  L.push("");
  L.push(`| Metric     | Score |`);
  L.push(`|------------|-------|`);
  L.push(`| Recall@1   | **${pct(overall.r1, overall.n)}** (${overall.r1}/${overall.n}) |`);
  L.push(`| Recall@3   | **${pct(overall.r3, overall.n)}** (${overall.r3}/${overall.n}) |`);
  L.push(`| Recall@5   | **${pct(overall.r5, overall.n)}** (${overall.r5}/${overall.n}) |`);
  L.push(`| MRR        | **${overall.mrr.toFixed(3)}** |`);
  L.push("");

  L.push("### By Query Type");
  L.push("");
  L.push(`| Type        | N  | @1  | @3  | @5  | MRR   |`);
  L.push(`|-------------|----|-----|-----|-----|-------|`);

  const typeOrder = ["exact", "natural", "concept", "troubleshoot", "flag", "cross-plugin"];
  for (const t of typeOrder) {
    const rs = byType.get(t);
    if (!rs || rs.length === 0) continue;
    const s = (() => {
      const n = rs.length;
      const r1  = rs.filter((r) => r.rank === 1).length;
      const r3  = rs.filter((r) => r.rank > 0 && r.rank <= 3).length;
      const r5  = rs.filter((r) => r.rank > 0 && r.rank <= 5).length;
      const mrr = rs.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / n;
      return { n, r1, r3, r5, mrr };
    })();
    L.push(`| ${pad(t, 11)} | ${pad(s.n, 2)} | ${pct(s.r1, s.n).padStart(3)} | ${pct(s.r3, s.n).padStart(3)} | ${pct(s.r5, s.n).padStart(3)} | ${s.mrr.toFixed(3)} |`);
  }
  L.push("");

  // ── Phase A misses table ─────────────────────────────────────────────────
  const misses = bm25.filter((r) => r.rank === 0);
  if (misses.length > 0) {
    L.push("### Misses (expected not in top-10)");
    L.push("");
    L.push(`| Query | Type | Expected ID | Top Hit |`);
    L.push(`|-------|------|-------------|---------|`);
    for (const r of misses) {
      L.push(`| \`${r.gt.query}\` | ${r.gt.queryType} | \`${r.gt.expectedId}\` | \`${r.topId || "—"}\` |`);
    }
    L.push("");
  }

  // ── Phase A deep rank table ───────────────────────────────────────────────
  const deep = bm25.filter((r) => r.rank >= 2 && r.rank <= 10).sort((a, b) => b.rank - a.rank);
  if (deep.length > 0) {
    L.push("### Found but ranked deep (rank 2–10)");
    L.push("");
    L.push(`| Rank | Query | Type | Expected ID |`);
    L.push(`|------|-------|------|-------------|`);
    for (const r of deep.slice(0, 30)) {
      L.push(`| ${r.rank} | \`${r.gt.query}\` | ${r.gt.queryType} | \`${r.gt.expectedId}\` |`);
    }
    L.push("");
  }

  // ── Phase B ──────────────────────────────────────────────────────────────
  L.push("## Phase B — LLM Answer Quality");
  L.push("");

  if (!lmUp) {
    L.push(`_Skipped — LM server unreachable at ${LM_URL}._`);
    L.push("_Re-run without --no-llm once llama-server is running._");
    L.push("");
  } else {
    const valid = llm.filter((r) => !r.skipped);
    const skipped = llm.filter((r) => r.skipped);
    const flagged = llm.filter((r) => r.gt.mustContainFlag != null && !r.skipped);

    const hallRate = pct(valid.filter((r) => r.hallucinated === 1).length, valid.length);
    const correctRate = pct(valid.filter((r) => r.correct_command === 1).length, valid.length);
    const flagRate = pct(flagged.filter((r) => r.has_flag === 1).length, flagged.length);
    const refuseRate = pct(valid.filter((r) => r.refused === 1).length, valid.length);

    L.push(`LM URL: \`${LM_URL}\``);
    L.push(`Sampled: ${llm.length}, judged: ${valid.length}, skipped/error: ${skipped.length}`);
    L.push("");
    L.push("### Aggregate Scores");
    L.push("");
    L.push(`| Metric            | Score | Note |`);
    L.push(`|-------------------|-------|------|`);
    L.push(`| Hallucination rate | **${hallRate}** | lower is better |`);
    L.push(`| Correct command   | **${correctRate}** | higher is better |`);
    L.push(`| Has required flag | **${flagRate}** | higher is better (${flagged.length} queries) |`);
    L.push(`| Wrong refusal     | **${refuseRate}** | model refuses when answer exists |`);
    L.push("");

    // By query type
    const llmTypes = ["natural", "concept", "troubleshoot", "flag"] as const;
    L.push("### By Query Type");
    L.push("");
    L.push(`| Type        | N  | Correct | No-Hall | Flag OK |`);
    L.push(`|-------------|----|---------|---------|---------|`);
    for (const t of llmTypes) {
      const rs = valid.filter((r) => r.gt.queryType === t);
      if (rs.length === 0) continue;
      const correct = rs.filter((r) => r.correct_command === 1).length;
      const noHall = rs.filter((r) => r.hallucinated === 0).length;
      const flagRs = rs.filter((r) => r.has_flag !== null);
      const flagOk = flagRs.filter((r) => r.has_flag === 1).length;
      const flagStr = flagRs.length > 0 ? pct(flagOk, flagRs.length) : "—";
      L.push(`| ${pad(t, 11)} | ${pad(rs.length, 2)} | ${pct(correct, rs.length).padStart(7)} | ${pct(noHall, rs.length).padStart(7)} | ${flagStr.padStart(7)} |`);
    }
    L.push("");

    // Per-query detail table
    L.push("### Per-Query Results");
    L.push("");
    L.push(`| Type | Query | Correct | Hall | Flag | Refused | Answer (truncated) |`);
    L.push(`|------|-------|---------|------|------|---------|-------------------|`);
    for (const r of valid) {
      const flagCell = r.has_flag === null ? "—" : r.has_flag === 1 ? "✓" : "✗";
      const answerSnip = r.answer.replace(/\n/g, " ").slice(0, 80);
      L.push(`| ${r.gt.queryType} | \`${r.gt.query}\` | ${r.correct_command === 1 ? "✓" : "✗"} | ${r.hallucinated === 1 ? "⚠" : "✓"} | ${flagCell} | ${r.refused === 1 ? "⚠" : "✓"} | ${answerSnip} |`);
    }
    L.push("");

    // Failures detail
    const failures = valid.filter(
      (r) => r.correct_command === 0 || r.hallucinated === 1 || r.refused === 1 || r.has_flag === 0,
    );
    if (failures.length > 0) {
      L.push("### Failures — Full Answers");
      L.push("");
      for (const r of failures) {
        L.push(`#### \`${r.gt.query}\` (${r.gt.queryType})`);
        L.push(`- Expected: \`${r.gt.expectedId}\``);
        L.push(`- correct_command: ${r.correct_command} | hallucinated: ${r.hallucinated} | refused: ${r.refused} | has_flag: ${r.has_flag ?? "N/A"}`);
        L.push("```");
        L.push(r.answer);
        L.push("```");
        L.push("");
      }
    }

    if (skipped.length > 0) {
      L.push("### Skipped / Errors");
      L.push("");
      for (const r of skipped) {
        L.push(`- \`${r.gt.query}\`: ${r.error}`);
      }
      L.push("");
    }
  }

  return L.join("\n");
}

// ─── Console summary ──────────────────────────────────────────────────────────

function printConsoleSummary(
  bm25: BM25Result[],
  llm: LLMResult[],
  lmUp: boolean,
): void {
  const { overall } = phaseAStats(bm25);
  console.log("");
  console.log("━━━ Phase A — BM25 Retrieval ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Recall@1  ${pct(overall.r1, overall.n).padStart(6)}   (${overall.r1}/${overall.n})`);
  console.log(`  Recall@3  ${pct(overall.r3, overall.n).padStart(6)}   (${overall.r3}/${overall.n})`);
  console.log(`  Recall@5  ${pct(overall.r5, overall.n).padStart(6)}   (${overall.r5}/${overall.n})`);
  console.log(`  MRR       ${overall.mrr.toFixed(3).padStart(6)}`);

  const misses = bm25.filter((r) => r.rank === 0);
  if (misses.length > 0) {
    console.log(`\n  ✗ Misses (${misses.length}):`);
    for (const r of misses) {
      console.log(`    [${r.gt.queryType}] "${r.gt.query}" → expected ${r.gt.expectedId}, got ${r.topId || "nothing"}`);
    }
  }

  if (!lmUp) {
    console.log("");
    console.log("━━━ Phase B — LLM  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  Skipped (LM unreachable at ${LM_URL})`);
    return;
  }

  const valid = llm.filter((r) => !r.skipped);
  const flagged = llm.filter((r) => r.has_flag !== null && !r.skipped);
  const hallCount = valid.filter((r) => r.hallucinated === 1).length;
  const correctCount = valid.filter((r) => r.correct_command === 1).length;
  const flagCount = flagged.filter((r) => r.has_flag === 1).length;
  const refuseCount = valid.filter((r) => r.refused === 1).length;

  console.log("");
  console.log("━━━ Phase B — LLM Answer Quality ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Queries judged : ${valid.length} (skipped: ${llm.length - valid.length})`);
  console.log(`  Correct command: ${pct(correctCount, valid.length).padStart(6)}  (${correctCount}/${valid.length})`);
  console.log(`  Hallucination  : ${pct(hallCount, valid.length).padStart(6)}  (${hallCount}/${valid.length})  ← lower is better`);
  console.log(`  Has flag       : ${pct(flagCount, flagged.length).padStart(6)}  (${flagCount}/${flagged.length} flag queries)`);
  console.log(`  Wrong refusal  : ${pct(refuseCount, valid.length).padStart(6)}  (${refuseCount}/${valid.length})`);

  const failures = valid.filter(
    (r) => r.correct_command === 0 || r.hallucinated === 1 || r.refused === 1 || r.has_flag === 0,
  );
  if (failures.length > 0) {
    console.log(`\n  ✗ Failures (${failures.length}):`);
    for (const r of failures) {
      const flags = [
        r.correct_command === 0 ? "wrong_cmd" : null,
        r.hallucinated === 1    ? "hallucinated" : null,
        r.refused === 1         ? "refused" : null,
        r.has_flag === 0        ? `missing_flag(${r.gt.mustContainFlag})` : null,
      ].filter(Boolean).join(", ");
      console.log(`    [${r.gt.queryType}] "${r.gt.query}" — ${flags}`);
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("bee ask Benchmark");
  console.log("─────────────────────────────────────────────────────────────────");
  console.log("Bootstrapping corpus…");

  const corpus = await bootstrapCorpus();
  console.log(
    `Corpus ready: ${corpus.length} items ` +
    `(${corpus.filter((d) => d.type === "command").length} commands, ` +
    `${corpus.filter((d) => d.type === "doc").length} doc chunks)`,
  );
  console.log(`Ground-truth queries: ${GROUND_TRUTH.length}`);

  // Phase A
  console.log("\nRunning Phase A — BM25 retrieval…");
  const bm25Results = runPhaseA(corpus);

  // Phase B
  let llmResults: LLMResult[] = [];
  const lmUp = !NO_LLM && await lmReachable();

  if (NO_LLM) {
    console.log("\nPhase B — skipped (--no-llm)");
  } else if (!lmUp) {
    console.log(`\nPhase B — LM unreachable at ${LM_URL}, skipping`);
  } else {
    console.log(`\nRunning Phase B — LLM at ${LM_URL}…`);
    llmResults = await runPhaseB(corpus);
  }

  // Console summary
  printConsoleSummary(bm25Results, llmResults, lmUp);

  // Markdown report
  const report = buildReport(corpus, bm25Results, llmResults, lmUp);
  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
