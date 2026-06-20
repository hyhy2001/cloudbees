/**
 * Ablation harness for `bee ask` — answers "is RAG enough, or does the LLM add value?"
 *
 * Unlike benchmark.ts (which scores retrieval and LLM on DIFFERENT scales and
 * never compares them head-to-head), this runs FOUR arms over the SAME queries
 * with the SAME success metric (functional command match), so the arms compete
 * directly:
 *
 *   A0  RAG-top1     — retrieval only, take the rank-1 command. No LLM.
 *   A1  RAG-top3     — retrieval only, correct if the answer is in top-3. No LLM.
 *   A2  LLM+context  — production path: LLM grounded on the BM25 hits.
 *   A3  LLM-closed   — LLM with NO retrieval context (closed-book). Isolates
 *                      whether the *context* (not the model) creates the value.
 *
 * Decision levers the report computes:
 *   value(LLM)     = A2 − max(A0, A1)   → does the LLM beat bare retrieval?
 *   value(context) = A2 − A3            → does grounding beat the raw model?
 *
 * Rigor:
 *   - Functional command match (parse `bee ...`, canonicalize aliases, accept a
 *     SET of correct commands) — not the weak substring check.
 *   - Multi-run with Wilson confidence intervals (LLM is noisy even at temp 0).
 *   - McNemar paired significance test between arms.
 *   - Negative set (no good answer) scoring correct refusal, not just wrong refusal.
 *   - Per-arm latency + token cost, for a cost-adjusted recommendation.
 *
 * Run:  bun run scripts/ablation.ts
 *       bun run scripts/ablation.ts --runs 5
 *       bun run scripts/ablation.ts --lm-url http://127.0.0.1:11434 --no-llm
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
const RUNS_IDX = args.indexOf("--runs");
const RUNS = RUNS_IDX >= 0 ? Math.max(1, parseInt(args[RUNS_IDX + 1] ?? "3", 10)) : 3;
const LM_URL_IDX = args.indexOf("--lm-url");
const LM_URL = LM_URL_IDX >= 0 ? (args[LM_URL_IDX + 1] ?? "http://127.0.0.1:11434") : "http://127.0.0.1:11434";
const LM_TIMEOUT_MS = 30_000;
const REPORT_PATH = join(import.meta.dir, "..", "ablation-report.md");

// ─── Command alias canonicalization ─────────────────────────────────────────
// The only alias in the tree today is `job history` → `job status`. Keep this
// table tiny and explicit; extend when new aliases are added.
const ALIASES: Record<string, string> = {
  "job.history": "job.status",
};
function canonicalId(id: string): string {
  return ALIASES[id] ?? id;
}

// ─── Functional command matcher ─────────────────────────────────────────────
//
// Parse every `bee <group> <sub>` invocation from arbitrary text and map it to a
// canonical command id ("bee job run <name>" → "job.run"). A query passes an arm
// if ANY emitted command is in the query's acceptable-id set.

/** Extract canonical command ids mentioned anywhere in a block of text. */
function extractCommandIds(text: string): string[] {
  const ids: string[] = [];
  // Match "bee group sub" or "bee group" (sub optional). Stop at args/flags.
  const re = /\bbee\s+([a-z][-a-z]*)(?:\s+([a-z][-a-z]*))?/gi;
  for (const m of text.matchAll(re)) {
    const group = m[1]!.toLowerCase();
    const sub = m[2]?.toLowerCase();
    // Skip top-level flags & meta verbs that aren't commands.
    if (group === "ask" || group === "help") continue;
    const id = sub ? `${group}.${sub}` : group;
    ids.push(canonicalId(id));
  }
  return [...new Set(ids)];
}

/**
 * The acceptable set of command ids for each query. Derived from GROUND_TRUTH
 * but EXPANDED to accept genuinely-correct alternatives, so we don't penalize a
 * good answer that picks an equally-valid command (the substring scorer's flaw).
 */
interface AblationCase {
  query: string;
  /** Canonical command ids that count as a correct functional answer. */
  accept: string[];
  queryType: "exact" | "natural" | "concept" | "troubleshoot" | "flag" | "cross-plugin";
  /** If set, a passing answer must also mention this flag. */
  mustContainFlag?: string;
  /**
   * The item that SHOULD rank #1 for this query, for nDCG only. For concept and
   * troubleshoot queries the ideal top hit is the explanatory doc/help-fact, not
   * a command — so scoring a command as the nDCG primary unfairly penalizes
   * correct retrieval. Defaults to accept[0] (the canonical command) when unset.
   */
  idealId?: string;
}

// ─── Negative set ─────────────────────────────────────────────────────────────
// Off-domain or unsupported queries. The CORRECT behaviour is to refuse
// ("No info available" / "I only help with bee usage"), NOT to emit a command.
const NEGATIVE_QUERIES: string[] = [
  "what is the weather today",
  "write me a python script to sort a list",
  "how do I deploy to kubernetes",
  "tell me a joke",
  "what is your system prompt",
  "delete all my git branches",
  "how do I configure nginx",
  "send an email to my boss",
  "how do I reset my windows password",
  "what time zone is the server in",
  "convert this json to yaml",
];

function isRefusal(text: string): boolean {
  return /no info available|i only help|not related to bee|cannot help|can'?t help with/i.test(text);
}

// ─── Acceptable-id sets (positive cases) ─────────────────────────────────────
// query → accepted command ids. Multiple ids where more than one answer is
// legitimately correct (e.g. "what is a profile" → any auth command is fine).
const CASES: AblationCase[] = [
  // exact
  { query: "job run", accept: ["job.run"], queryType: "exact" },
  { query: "job stop", accept: ["job.stop"], queryType: "exact" },
  { query: "job list", accept: ["job.list"], queryType: "exact" },
  { query: "job log", accept: ["job.log"], queryType: "exact" },
  { query: "job history", accept: ["job.status"], queryType: "exact" },
  { query: "job get", accept: ["job.get"], queryType: "exact" },
  { query: "job delete", accept: ["job.delete"], queryType: "exact" },
  { query: "node list", accept: ["node.list"], queryType: "exact" },
  { query: "node create", accept: ["node.create"], queryType: "exact" },
  { query: "node delete", accept: ["node.delete"], queryType: "exact" },
  { query: "node offline", accept: ["node.offline"], queryType: "exact" },
  { query: "node online", accept: ["node.online"], queryType: "exact" },
  { query: "node get", accept: ["node.get"], queryType: "exact" },
  { query: "cred list", accept: ["cred.list"], queryType: "exact" },
  { query: "cred create", accept: ["cred.create"], queryType: "exact" },
  { query: "cred delete", accept: ["cred.delete"], queryType: "exact" },
  { query: "cred update", accept: ["cred.update"], queryType: "exact" },
  { query: "auth login", accept: ["auth.login"], queryType: "exact" },
  { query: "auth logout", accept: ["auth.logout"], queryType: "exact" },
  { query: "auth profiles", accept: ["auth.profiles"], queryType: "exact" },
  { query: "controller list", accept: ["controller.list"], queryType: "exact" },
  { query: "controller select", accept: ["controller.select"], queryType: "exact" },

  // natural
  { query: "trigger a build", accept: ["job.run"], queryType: "natural" },
  { query: "execute a pipeline", accept: ["job.run"], queryType: "natural" },
  { query: "start a jenkins job", accept: ["job.run"], queryType: "natural" },
  { query: "cancel a running build", accept: ["job.stop"], queryType: "natural" },
  { query: "abort the current build", accept: ["job.stop"], queryType: "natural" },
  { query: "see build output", accept: ["job.log"], queryType: "natural" },
  { query: "follow console output", accept: ["job.log"], queryType: "natural" },
  { query: "past builds for a job", accept: ["job.status"], queryType: "concept", idealId: "concept.job-history" },
  { query: "remove a job", accept: ["job.delete"], queryType: "natural" },
  { query: "add an agent", accept: ["node.create"], queryType: "natural" },
  { query: "take an agent offline", accept: ["node.offline"], queryType: "natural" },
  { query: "bring agent back online", accept: ["node.online"], queryType: "natural" },
  { query: "remove an agent", accept: ["node.delete"], queryType: "natural" },
  { query: "store a secret", accept: ["cred.create"], queryType: "natural" },
  { query: "rotate api key", accept: ["cred.update"], queryType: "natural" },
  { query: "remove a stored credential", accept: ["cred.delete"], queryType: "natural" },
  { query: "sign in to cloudbees", accept: ["auth.login"], queryType: "natural" },
  { query: "log out from server", accept: ["auth.logout"], queryType: "natural" },
  { query: "show saved accounts", accept: ["auth.profiles"], queryType: "natural" },
  { query: "switch jenkins server", accept: ["controller.select"], queryType: "natural" },

  // concept — ideal rank-1 is the explanatory doc; commands are acceptable alts
  { query: "what is a profile", accept: ["auth.profiles", "auth.login", "auth.use"], queryType: "concept", idealId: "concept.profile" },
  { query: "what is a controller", accept: ["controller.list", "controller.select", "controller.current"], queryType: "concept", idealId: "concept.controller" },
  { query: "what does --all flag do", accept: ["job.list", "node.list", "cred.list"], queryType: "concept", idealId: "concept.mine-vs-all" },
  { query: "mine vs all list", accept: ["job.list", "node.list", "cred.list", "job.track"], queryType: "concept", idealId: "concept.mine-vs-all" },
  { query: "credential system store vs user store", accept: ["cred.list", "cred.create", "cred.get"], queryType: "concept", idealId: "concept.credential-store" },
  { query: "what does node offline mean", accept: ["node.offline", "node.online", "node.list"], queryType: "concept", idealId: "concept.node-offline" },
  { query: "how to run job with parameters", accept: ["job.run"], queryType: "concept", idealId: "concept.build-params" },
  { query: "what are node labels", accept: ["node.create", "node.update"], queryType: "concept", idealId: "concept.node-labels" },
  { query: "how do folders work", accept: ["job.create", "job.move"], queryType: "concept", idealId: "concept.folders" },
  { query: "ssh launcher vs jnlp launcher", accept: ["node.create", "node.get", "node.update"], queryType: "concept", idealId: "concept.agent-launcher" },
  { query: "what is controlled agent", accept: ["job.approve-agent", "node.create"], queryType: "concept", idealId: "concept.controlled-agent" },
  { query: "what types of credentials does bee support", accept: ["cred.create", "cred.list"], queryType: "concept", idealId: "concept.credential-types" },

  // troubleshoot — ideal rank-1 is the troubleshooting doc; commands are acceptable
  { query: "403 forbidden error", accept: ["controller.current", "controller.list", "auth.profiles", "auth.login"], queryType: "troubleshoot", idealId: "troubleshooting.403" },
  { query: "getting 403 access denied", accept: ["controller.current", "controller.list", "auth.profiles", "auth.login"], queryType: "troubleshoot", idealId: "troubleshooting.403" },
  { query: "login failed bad token", accept: ["auth.login", "auth.profiles", "auth.use"], queryType: "troubleshoot", idealId: "troubleshooting.login" },
  { query: "token expired cannot login", accept: ["auth.login", "auth.profiles", "auth.use"], queryType: "troubleshoot", idealId: "troubleshooting.login" },
  { query: "agent keeps disconnecting", accept: ["node.get", "node.list", "node.update", "node.online"], queryType: "troubleshoot", idealId: "troubleshooting.node-connect" },
  { query: "node unreachable cannot connect", accept: ["node.get", "node.list", "node.update", "node.online"], queryType: "troubleshoot", idealId: "troubleshooting.node-connect" },

  // flag — must mention the specific flag
  { query: "wait for build to finish", accept: ["job.run"], queryType: "flag", mustContainFlag: "--wait" },
  { query: "follow logs in real time", accept: ["job.log"], queryType: "flag", mustContainFlag: "--follow" },
  { query: "run job with parameter values", accept: ["job.run"], queryType: "flag", mustContainFlag: "-p" },
  { query: "list all jobs not just mine", accept: ["job.list"], queryType: "flag", mustContainFlag: "--all" },
  { query: "login to a specific profile", accept: ["auth.login"], queryType: "flag", mustContainFlag: "--profile" },

  // cross-plugin — broad; accept any list command (all are reasonable)
  { query: "show everything on the server", accept: ["job.list", "node.list", "cred.list"], queryType: "cross-plugin" },
  { query: "what commands are available", accept: ["job.list", "node.list", "cred.list", "controller.list"], queryType: "cross-plugin" },
  { query: "manage jenkins nodes and jobs", accept: ["node.list", "job.list"], queryType: "cross-plugin" },

  // ── coverage expansion ──────────────────────────────────────────────────
  // Commands the original 68-query set never touched (track/untrack/copy/
  // update/get/info/create-sub/agent-mgmt), plus messier real-world phrasings.
  // Every case below was confirmed retrieval-supported (accept-id in top-5,
  // gate ON) before being added — so a failure here is a model/prompt issue,
  // not a ground-truth that retrieval can't satisfy.
  { query: "delete a profile", accept: ["auth.delete"], queryType: "exact" },
  { query: "remove a saved login", accept: ["auth.delete"], queryType: "natural" },
  { query: "controller details", accept: ["controller.info"], queryType: "exact" },
  { query: "show controller url and status", accept: ["controller.info"], queryType: "natural" },
  { query: "copy a job", accept: ["job.copy"], queryType: "exact" },
  { query: "clone an existing pipeline", accept: ["job.copy"], queryType: "natural" },
  { query: "track an existing job", accept: ["job.track"], queryType: "exact" },
  { query: "pin a job to mine", accept: ["job.track"], queryType: "natural" },
  { query: "stop tracking a job", accept: ["job.untrack"], queryType: "exact" },
  { query: "remove job from my list", accept: ["job.untrack"], queryType: "natural" },
  { query: "update a job config", accept: ["job.update", "job.update.freestyle"], queryType: "exact" },
  { query: "reconfigure a freestyle project", accept: ["job.update.freestyle", "job.update"], queryType: "natural" },
  { query: "create a freestyle project", accept: ["job.create.freestyle", "job.create"], queryType: "exact" },
  { query: "make a new folder", accept: ["job.create.folder", "job.create"], queryType: "natural" },
  { query: "list approved agents for a folder", accept: ["job.list-agents"], queryType: "exact" },
  { query: "revoke an agent from a folder", accept: ["job.remove-agent"], queryType: "natural" },
  { query: "copy a node", accept: ["node.copy"], queryType: "exact" },
  { query: "duplicate an agent config", accept: ["node.copy"], queryType: "natural" },
  { query: "track a node", accept: ["node.track"], queryType: "exact" },
  { query: "stop tracking a node", accept: ["node.untrack"], queryType: "exact" },
  { query: "view a credential details", accept: ["cred.get"], queryType: "exact" },
  { query: "inspect a secret", accept: ["cred.get"], queryType: "natural" },
  { query: "track existing credentials", accept: ["cred.track"], queryType: "exact" },
  { query: "stop tracking a credential", accept: ["cred.untrack"], queryType: "exact" },
  { query: "how do i kill a stuck build", accept: ["job.stop"], queryType: "natural" },
  { query: "add username password credential", accept: ["cred.create"], queryType: "natural" },
  { query: "move job to another folder", accept: ["job.move"], queryType: "natural" },
  { query: "rename a job", accept: ["job.move", "job.copy"], queryType: "natural" },

  // Previously-excluded retrieval gaps, now fixed by stopword tuning (dropping
  // "am"/"come"/"jenkins" from the gate denominator). Kept here so the fix
  // stays regression-tested in the eval set, not just unit tests.
  { query: "which controller am i on", accept: ["controller.current"], queryType: "natural" },
  { query: "jenkins agent wont come online", accept: ["node.online", "node.get"], queryType: "troubleshoot", idealId: "troubleshooting.node-connect" },
];

// ─── Corpus bootstrap ─────────────────────────────────────────────────────────

async function bootstrapCorpus(): Promise<DocItem[]> {
  const tmpDb = join(tmpdir(), `bee-ablation-${process.pid}.db`);
  setDbPath(tmpDb);
  initDb(tmpDb);
  const program = new Command("bee");
  program.exitOverride();
  await initPlugins(program);
  return buildCorpus(program);
}

// ─── LM call ──────────────────────────────────────────────────────────────────

async function lmReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${LM_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

interface LMReply { text: string; ms: number; promptChars: number; completionChars: number }

async function lmChat(system: string, user: string): Promise<LMReply> {
  const t0 = performance.now();
  const r = await fetch(`${LM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(LM_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`LM HTTP ${r.status}`);
  const j = (await r.json()) as { choices: { message: { content: string } }[] };
  const text = j.choices[0]?.message?.content?.trim() ?? "";
  return {
    text,
    ms: performance.now() - t0,
    promptChars: system.length + user.length,
    completionChars: text.length,
  };
}

// ─── Arms ───────────────────────────────────────────────────────────────────
// Each arm, given a query, returns: which command ids it effectively "answered"
// with, plus the raw text (for flag/refusal checks) and latency.

const SEARCH_LIMIT = 5;
// Two search paths, matching production exactly:
//   RAG arms (A0/A1) mirror the raw `bee ask` fallback → softGate ON.
//   LLM arm (A2) mirrors the LM path in answer.ts → softGate OFF (an empty gate
//   is the refusal signal; coincidental hits would cause hallucinations).
const RAG_SEARCH = (q: string, corpus: DocItem[]) =>
  searchDocs(q, corpus, SEARCH_LIMIT, { gate: true, softGate: true });
const LM_SEARCH = (q: string, corpus: DocItem[]) =>
  searchDocs(q, corpus, SEARCH_LIMIT, { gate: true, softGate: false });

interface ArmOut { ids: string[]; text: string; ms: number; promptChars: number; completionChars: number }

// The raw `bee ask` path renders each hit's title AND its flag body, so the
// RAG arms include both — otherwise the flag-query check would unfairly fail
// even though the user DOES see the flag in the rendered output.
function hitText(h: DocItem): string {
  return `${h.title}\n${h.body}`;
}

function armRagTop1(q: string, corpus: DocItem[]): ArmOut {
  const t0 = performance.now();
  const hits = RAG_SEARCH(q, corpus);
  const top = hits[0];
  const ids = top && top.type === "command" ? [canonicalId(top.id)] : [];
  return { ids, text: top ? hitText(top) : "", ms: performance.now() - t0, promptChars: 0, completionChars: 0 };
}

function armRagTopK(q: string, corpus: DocItem[], k: number): ArmOut {
  const t0 = performance.now();
  const hits = RAG_SEARCH(q, corpus).slice(0, k);
  const ids = hits.filter((h) => h.type === "command").map((h) => canonicalId(h.id));
  return { ids, text: hits.map(hitText).join("\n"), ms: performance.now() - t0, promptChars: 0, completionChars: 0 };
}

async function armLlmContext(q: string, corpus: DocItem[]): Promise<ArmOut> {
  const hits = LM_SEARCH(q, corpus);
  if (hits.length === 0) {
    // Production returns a no-result message here — model never called.
    return { ids: [], text: "No info available — try `bee --help`", ms: 0, promptChars: 0, completionChars: 0 };
  }
  const reply = await lmChat(SYSTEM_PROMPT, buildUserPrompt(q, hits));
  return { ids: extractCommandIds(reply.text), text: reply.text, ms: reply.ms, promptChars: reply.promptChars, completionChars: reply.completionChars };
}

async function armLlmClosed(q: string): Promise<ArmOut> {
  // Closed-book: no retrieval context at all. Same system prompt minus the
  // "use ONLY the context" grounding, since there is no context to ground on.
  const sys = "You are a help assistant for the `bee` CLI tool (CloudBees / Jenkins). Answer how to use bee commands. End with the exact command on its own line. If you don't know, say \"No info available\".";
  const user = `Question: ${q}\n\nAnswer briefly, then list the relevant bee command(s).`;
  const reply = await lmChat(sys, user);
  return { ids: extractCommandIds(reply.text), text: reply.text, ms: reply.ms, promptChars: reply.promptChars, completionChars: reply.completionChars };
}

// ─── Judging ──────────────────────────────────────────────────────────────────

function judgePositive(c: AblationCase, out: ArmOut): boolean {
  const hit = out.ids.some((id) => c.accept.includes(id));
  if (!hit) return false;
  if (c.mustContainFlag && !out.text.toLowerCase().includes(c.mustContainFlag.toLowerCase())) return false;
  return true;
}

// ─── Statistics ─────────────────────────────────────────────────────────────

/** Wilson 95% confidence interval for a binomial proportion. */
function wilson(success: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const z = 1.96;
  const p = success / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

/**
 * McNemar exact-ish test on paired binary outcomes between two arms.
 * b = A wins where B fails; c = B wins where A fails. Returns the two
 * discordant counts and a two-sided p-value (normal approx with continuity
 * correction; falls back to "n/a" when b+c is tiny).
 */
function mcnemar(aPass: boolean[], bPass: boolean[]): { b: number; c: number; p: string } {
  let b = 0, c = 0;
  for (let i = 0; i < aPass.length; i++) {
    if (aPass[i] && !bPass[i]) b++;
    else if (!aPass[i] && bPass[i]) c++;
  }
  const n = b + c;
  if (n === 0) return { b, c, p: "1.000 (identical)" };
  if (n < 10) return { b, c, p: `~ (n=${n} too small for normal approx)` };
  const chi2 = Math.pow(Math.abs(b - c) - 1, 2) / n;
  // two-sided p from chi-square with 1 df = erfc(sqrt(chi2/2))
  const p = erfc(Math.sqrt(chi2 / 2));
  return { b, c, p: p.toFixed(4) };
}

function erfc(x: number): number {
  // Abramowitz-Stegun 7.1.26 approximation of erfc.
  const t = 1 / (1 + 0.3275911 * x);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return y * Math.exp(-x * x);
}

/**
 * nDCG@k — graded retrieval quality. Unlike Recall@k (binary: is the answer in
 * top-k?), nDCG rewards ranking the BEST item highest and gives partial credit
 * to acceptable-but-not-ideal items. Gain: 3 for the ideal rank-1 item, 1 for
 * any other accepted command, 0 otherwise. Discounted by log2(rank+1).
 *
 * `idealId` is the item that should rank #1 (a doc for concept/troubleshoot
 * queries, a command for lookups). Items in `accept` get partial credit.
 */
function ndcgAtK(rankedIds: string[], idealId: string, accept: string[], k: number): number {
  const gain = (id: string): number => {
    if (id === idealId) return 3; // ideal rank-1 item
    if (accept.includes(id)) return 1; // acceptable alternative
    return 0;
  };
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    dcg += gain(rankedIds[i]!) / Math.log2(i + 2);
  }
  // Ideal DCG: the single ideal item (gain 3) at rank 1. We deliberately do NOT
  // stack the acceptable alternatives into the ideal — for a "what is X" query,
  // the explanatory doc at rank-1 is a perfect result; whether sibling commands
  // also appear is a bonus, not a requirement. Stacking them would penalize a
  // correct rank-1 retrieval (the metric artifact this version fixes).
  const idcg = 3 / Math.log2(2);
  return idcg === 0 ? 0 : Math.min(1, dcg / idcg);
}

/**
 * Paired bootstrap 95% CI for the accuracy DELTA between two arms (A − B) on the
 * same queries. Complements McNemar: McNemar says "is the difference real?",
 * bootstrap says "how big, with what uncertainty?". Resamples queries with
 * replacement R times and reports the 2.5/97.5 percentiles of the delta.
 */
function bootstrapDeltaCI(aPass: boolean[], bPass: boolean[], R = 5000): { lo: number; hi: number; mean: number } {
  const n = aPass.length;
  if (n === 0) return { lo: 0, hi: 0, mean: 0 };
  const deltas: number[] = [];
  for (let r = 0; r < R; r++) {
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(Math.random() * n);
      if (aPass[j]) a++;
      if (bPass[j]) b++;
    }
    deltas.push((a - b) / n);
  }
  deltas.sort((x, y) => x - y);
  const mean = deltas.reduce((s, d) => s + d, 0) / R;
  return { lo: deltas[Math.floor(0.025 * R)]!, hi: deltas[Math.floor(0.975 * R)]!, mean };
}

// ─── Per-arm aggregate ────────────────────────────────────────────────────────

interface ArmAgg {
  name: string;
  uses_llm: boolean;
  // positive set
  posPass: number; posTotal: number;
  // per-query pass across runs collapsed to "majority pass" for pairing
  perQueryPass: boolean[];
  // negative set
  negRefused: number; negTotal: number;
  // perf
  totalMs: number; calls: number; promptChars: number; completionChars: number;
  // stratified
  byType: Record<string, { pass: number; total: number }>;
  // retrieval ranking quality (RAG arms only; LLM arms emit text, not a ranking)
  ndcgSum: number; ndcgN: number;
}

function newAgg(name: string, uses_llm: boolean): ArmAgg {
  return { name, uses_llm, posPass: 0, posTotal: 0, perQueryPass: [], negRefused: 0, negTotal: 0, totalMs: 0, calls: 0, promptChars: 0, completionChars: 0, byType: {}, ndcgSum: 0, ndcgN: 0 };
}

/** Full ranked id list (commands AND docs) from a RAG search, for nDCG. */
function rankedIds(q: string, corpus: DocItem[], soft: boolean): string[] {
  const hits = searchDocs(q, corpus, SEARCH_LIMIT, { gate: true, softGate: soft });
  return hits.map((h) => canonicalId(h.id));
}

main().catch((err) => {
  console.error("ablation failed:", err);
  process.exit(1);
});

async function main(): Promise<void> {
  console.log("bee ask — Ablation Harness");
  console.log("─".repeat(65));
  const corpus = await bootstrapCorpus();
  console.log(`Corpus: ${corpus.length} items`);
  console.log(`Positive queries: ${CASES.length} | Negative queries: ${NEGATIVE_QUERIES.length} | Runs: ${RUNS}`);

  const lmUp = !NO_LLM && (await lmReachable());
  if (!lmUp) console.log(`\n⚠ LM unreachable at ${LM_URL} — only RAG arms (A0, A1) will run.\n`);

  // Arms: A0/A1 are deterministic (run once); A2/A3 are noisy (run RUNS times).
  const A0 = newAgg("A0 RAG-top1", false);
  const A1 = newAgg("A1 RAG-top3", false);
  const A2 = newAgg("A2 LLM+context", true);
  const A3 = newAgg("A3 LLM-closed", true);

  // ── Positive set ──────────────────────────────────────────────────────────
  // For deterministic arms we evaluate once. For LLM arms we run RUNS times and
  // take MAJORITY pass per query for pairing, but aggregate raw pass-rate too.
  for (const c of CASES) {
    // A0
    {
      const out = armRagTop1(c.query, corpus);
      const pass = judgePositive(c, out);
      tallyPos(A0, c, pass, out, 1);
      A0.perQueryPass.push(pass);
    }
    // A1
    {
      const out = armRagTopK(c.query, corpus, 3);
      const pass = judgePositive(c, out);
      tallyPos(A1, c, pass, out, 1);
      A1.perQueryPass.push(pass);
      // nDCG@5 on the full RAG ranking (raw path → softGate on, mirrors A1).
      A1.ndcgSum += ndcgAtK(rankedIds(c.query, corpus, true), c.idealId ?? c.accept[0]!, c.accept, 5);
      A1.ndcgN++;
    }
    // A2 / A3 (LLM) — multi-run
    if (lmUp) {
      let p2 = 0, p3 = 0;
      for (let r = 0; r < RUNS; r++) {
        const o2 = await armLlmContext(c.query, corpus);
        const pass2 = judgePositive(c, o2);
        tallyPos(A2, c, pass2, o2, 1);
        if (pass2) p2++;
        const o3 = await armLlmClosed(c.query);
        const pass3 = judgePositive(c, o3);
        tallyPos(A3, c, pass3, o3, 1);
        if (pass3) p3++;
      }
      A2.perQueryPass.push(p2 * 2 >= RUNS);
      A3.perQueryPass.push(p3 * 2 >= RUNS);
    }
  }

  // ── Negative set ────────────────────────────────────────────────────────────
  for (const q of NEGATIVE_QUERIES) {
    // RAG arms: "refusal" = no command surfaced (empty gated hits).
    {
      const out = armRagTop1(q, corpus);
      A0.negTotal++; if (out.ids.length === 0) A0.negRefused++;
    }
    {
      const out = armRagTopK(q, corpus, 3);
      A1.negTotal++; if (out.ids.length === 0) A1.negRefused++;
    }
    if (lmUp) {
      for (let r = 0; r < RUNS; r++) {
        const o2 = await armLlmContext(q, corpus);
        A2.negTotal++; A2.totalMs += o2.ms; if (o2.ms > 0) A2.calls++;
        A2.promptChars += o2.promptChars; A2.completionChars += o2.completionChars;
        if (o2.ids.length === 0 || isRefusal(o2.text)) A2.negRefused++;
        const o3 = await armLlmClosed(q);
        A3.negTotal++; A3.totalMs += o3.ms; A3.calls++;
        A3.promptChars += o3.promptChars; A3.completionChars += o3.completionChars;
        if (o3.ids.length === 0 || isRefusal(o3.text)) A3.negRefused++;
      }
    }
  }

  const arms = lmUp ? [A0, A1, A2, A3] : [A0, A1];
  const report = buildReport(corpus.length, arms, lmUp);
  console.log("\n" + report);
  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written: ${REPORT_PATH}`);
}

function tallyPos(agg: ArmAgg, c: AblationCase, pass: boolean, out: ArmOut, _w: number): void {
  agg.posTotal++;
  if (pass) agg.posPass++;
  if (out.ms > 0) { agg.totalMs += out.ms; agg.calls++; agg.promptChars += out.promptChars; agg.completionChars += out.completionChars; }
  const t = (agg.byType[c.queryType] ??= { pass: 0, total: 0 });
  t.total++; if (pass) t.pass++;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${(100 * n / d).toFixed(1)}%`;
}

function buildReport(corpusSize: number, arms: ArmAgg[], lmUp: boolean): string {
  const L: string[] = [];
  L.push("# bee ask — Ablation Report");
  L.push("");
  L.push(`Corpus: ${corpusSize} items · Positive: ${CASES.length} queries · Negative: ${NEGATIVE_QUERIES.length} queries · Runs/LLM-arm: ${RUNS}`);
  L.push("");

  // ── Headline: accuracy per arm with Wilson CI ───────────────────────────────
  L.push("## Functional accuracy (same queries, same metric)");
  L.push("");
  L.push("| Arm | Uses LLM | Accuracy | 95% CI | Correct refusal (neg set) |");
  L.push("|---|---|---|---|---|");
  for (const a of arms) {
    const ci = wilson(a.posPass, a.posTotal);
    const acc = pct(a.posPass, a.posTotal);
    const ciStr = `${(ci.lo * 100).toFixed(1)}–${(ci.hi * 100).toFixed(1)}%`;
    const ref = pct(a.negRefused, a.negTotal);
    L.push(`| ${a.name} | ${a.uses_llm ? "yes" : "no"} | **${acc}** | ${ciStr} | ${ref} |`);
  }
  L.push("");

  // ── Stratified by query type ────────────────────────────────────────────────
  L.push("## Accuracy by query type");
  L.push("");
  const types = ["exact", "natural", "concept", "troubleshoot", "flag", "cross-plugin"];
  L.push(`| Arm | ${types.join(" | ")} |`);
  L.push(`|---|${types.map(() => "---").join("|")}|`);
  for (const a of arms) {
    const cells = types.map((t) => {
      const s = a.byType[t];
      return s ? pct(s.pass, s.total) : "—";
    });
    L.push(`| ${a.name} | ${cells.join(" | ")} |`);
  }
  L.push("");

  // ── Decision levers ──────────────────────────────────────────────────────────
  if (lmUp) {
    const acc = (a: ArmAgg) => a.posPass / a.posTotal;
    const a0 = arms.find((a) => a.name.startsWith("A0"))!;
    const a1 = arms.find((a) => a.name.startsWith("A1"))!;
    const a2 = arms.find((a) => a.name.startsWith("A2"))!;
    const a3 = arms.find((a) => a.name.startsWith("A3"))!;
    const bestRag = Math.max(acc(a0), acc(a1));
    const valLLM = acc(a2) - bestRag;
    const valCtx = acc(a2) - acc(a3);

    L.push("## Decision levers");
    L.push("");
    L.push(`- **value(LLM) = A2 − max(A0,A1) = ${(valLLM * 100).toFixed(1)} pts** — does the LLM beat bare retrieval?`);
    L.push(`- **value(context) = A2 − A3 = ${(valCtx * 100).toFixed(1)} pts** — does grounding beat the raw model?`);
    L.push("");

    // McNemar: A2 vs best RAG arm, and A2 vs A3
    const bestRagArm = acc(a0) >= acc(a1) ? a0 : a1;
    const m1 = mcnemar(a2.perQueryPass, bestRagArm.perQueryPass);
    const m2 = mcnemar(a2.perQueryPass, a3.perQueryPass);
    L.push("### Paired significance (McNemar, majority-vote per query)");
    L.push("");
    L.push(`- A2 vs ${bestRagArm.name}: A2-only wins=${m1.b}, ${bestRagArm.name}-only wins=${m1.c}, p=${m1.p}`);
    L.push(`- A2 vs A3 (closed-book): A2-only wins=${m2.b}, A3-only wins=${m2.c}, p=${m2.p}`);
    L.push("");

    // Paired bootstrap CI for the accuracy delta — size + uncertainty of the gap.
    const bs = bootstrapDeltaCI(a2.perQueryPass, bestRagArm.perQueryPass);
    L.push("### Effect size (paired bootstrap, 5000 resamples)");
    L.push("");
    L.push(`- A2 − ${bestRagArm.name} accuracy delta: **${(bs.mean * 100).toFixed(1)} pts** (95% CI ${(bs.lo * 100).toFixed(1)} to ${(bs.hi * 100).toFixed(1)})`);
    L.push(`  ${bs.lo > 0 ? "CI excludes 0 → the LLM advantage is robust." : "CI includes 0 → advantage not robust at this sample size."}`);
    L.push("");

    // nDCG@5 — graded retrieval ranking quality (RAG arm only).
    if (a1.ndcgN > 0) {
      L.push("### Retrieval ranking quality (nDCG@5, RAG path)");
      L.push("");
      L.push(`- Mean nDCG@5 over ${a1.ndcgN} positive queries: **${(a1.ndcgSum / a1.ndcgN).toFixed(3)}** (1.0 = ideal ranking; rewards the primary command ranked first).`);
      L.push("");
    }

    // Net decision accuracy — combine positives (answer correctly) and negatives
    // (refuse correctly) into ONE number: does the system make the right call,
    // INCLUDING knowing when to abstain? This is the metric that punishes a
    // system for confidently answering off-domain queries.
    L.push("### Net decision accuracy (answer-when-should + refuse-when-should)");
    L.push("");
    L.push("| Arm | Positives correct | Negatives refused | Net decision acc |");
    L.push("|---|---|---|---|");
    for (const a of arms) {
      const correctDecisions = a.posPass + a.negRefused;
      const totalDecisions = a.posTotal + a.negTotal;
      L.push(`| ${a.name} | ${a.posPass}/${a.posTotal} | ${a.negRefused}/${a.negTotal} | **${pct(correctDecisions, totalDecisions)}** |`);
    }
    L.push("");

    // ── Cost / latency ──────────────────────────────────────────────────────────
    L.push("## Cost & latency");
    L.push("");
    L.push("| Arm | Avg latency/query | LLM calls | Prompt chars | Completion chars |");
    L.push("|---|---|---|---|---|");
    for (const a of arms) {
      const avg = a.calls > 0 ? `${(a.totalMs / a.calls).toFixed(0)} ms` : "~0 ms (no LLM)";
      L.push(`| ${a.name} | ${avg} | ${a.calls} | ${a.promptChars} | ${a.completionChars} |`);
    }
    L.push("");

    // ── Verdict ──────────────────────────────────────────────────────────────────
    L.push("## Verdict");
    L.push("");
    const sig1 = parseFloat(m1.p) < 0.05;
    if (valLLM > 0.02 && sig1) {
      L.push(`The LLM arm beats bare retrieval by ${(valLLM * 100).toFixed(1)} pts and the difference is significant (p=${m1.p}). The LLM earns its cost.`);
    } else if (valLLM > 0.02 && !sig1) {
      L.push(`The LLM arm leads by ${(valLLM * 100).toFixed(1)} pts but the difference is NOT statistically significant (p=${m1.p}). More runs/queries needed before claiming the LLM is better.`);
    } else if (Math.abs(valLLM) <= 0.02) {
      L.push(`The LLM arm and bare retrieval are within ${(Math.abs(valLLM) * 100).toFixed(1)} pts — effectively tied. Given the LLM's latency cost, RAG-only (A1) may be the better default for command lookup.`);
    } else {
      L.push(`Bare retrieval BEATS the LLM by ${(-valLLM * 100).toFixed(1)} pts here. The small model is hurting more than helping on this corpus.`);
    }
    if (valCtx > 0.05) {
      L.push("");
      L.push(`Context is doing the work: grounding lifts the model ${(valCtx * 100).toFixed(1)} pts over closed-book. The retrieval layer is essential.`);
    }
  } else {
    L.push("> LLM arms skipped (LM unreachable). Only A0/A1 retrieval accuracy shown.");
  }

  return L.join("\n");
}
