/**
 * Answer orchestration for `bee ask`.
 *
 * The layer has two jobs:
 *   1. Define the `LMProvider` interface — the single seam providers plug into.
 *   2. Run `answer()` — build the full-context prompt when an LM is configured,
 *      otherwise fall back to the offline ranked hits so `bee ask` stays useful
 *      with no network or no provider.
 */

import { buildUserPrompt } from "./context";
import { searchDocs, type DocItem } from "./corpus";
// import { rerank } from "./rerank"; // disabled — see answer() comment
import { buildGraphFromCorpus, expandGraph, type CommandGraph } from "./graph";
import { getVectorDb, searchVector, rrfFusion, embed } from "./vector";

// --- Output hardening --------------------------------------------------------

/**
 * Defence-in-depth against fake commands in the LM answer.
 *
 * A small model, asked a broad question, sometimes lists plausible-but-
 * non-existent commands (`bee job start`, `bee list`). The relevance gate and
 * prompt grounding catch most of it, but not all, and this failure mode (a
 * confident wrong command the user will paste and run) is the worst kind.
 * Model-agnostic, so it holds regardless of which model or prompt is in use.
 *
 * Two passes:
 *   1. Backtick-wrapped `bee ...` spans — cross-reference each against the
 *      corpus of real command ids. Remove invented ones, keep real ones.
 *   2. Non-backtick `bee <group> <sub>` commands (e.g. "Use bee job list") —
 *      same validation; remove invented ones.
 * In both passes, "bee ask" and "bee help" are always valid.
 */
export function stripInventedCommands(text: string, corpus: DocItem[]): string {
  const valid = new Set<string>();
  const validFlags = new Set<string>();
  for (const item of corpus) {
    if (item.type !== "command") continue;
    valid.add(item.id);
    const dot = item.id.indexOf(".");
    if (dot > 0) valid.add(item.id.slice(0, dot));
    const body = item.body || "";
    const flagMatch = body.matchAll(/--[\w-]+/g);
    for (const m of flagMatch) validFlags.add(m[0]);
  }
  valid.add("ask");
  valid.add("help");
  // --help / --version are commander built-ins present on every command but
  // absent from corpus bodies; without these they get stripped as "invented".
  validFlags.add("--help");
  validFlags.add("--version");
  if (valid.size === 0) return text;

  const SENT = "";

  function isValidBeeCmd(group: string, sub?: string): boolean {
    const g = group.toLowerCase();
    const s = sub?.toLowerCase();
    if (g === "ask") return true;
    if (g === "help") return !s;
    const id = s ? `${g}.${s}` : g;
    return valid.has(id);
  }

  let result = text.replace(/`([^`]*)`/g, (_full, inner: string) => {
    const m = inner.match(/^\s*bee\s+([a-z][-a-z]*)(?:\s+([a-z][-a-z]*))?/i);
    if (!m) return _full;
    return isValidBeeCmd(m[1]!, m[2]) ? _full : SENT;
  });

  result = result.replace(
    /(^|[.:;\n])\s*(bee\s+([a-z][-a-z]*)(?:\s+([a-z][-a-z]*))?)/gi,
    (_full, boundary: string, cmd: string, group: string, sub?: string) => {
      return isValidBeeCmd(group, sub) ? _full : `${boundary} ${SENT}`;
    },
  );

  // Strip hallucinated flags (e.g. --agent) that don't exist on any command.
  result = result.replace(/(--[\w-]+)/g, (flag: string) => {
    return validFlags.has(flag) ? flag : SENT;
  });

  if (!result.includes(SENT)) return text;

  return result
    .replace(/\s*,\s*/g, "")       // ", <removed>"
    .replace(/\s*,\s*/g, "")       // "<removed>, "
    .replace(/\s+and\s+/gi, "")   // " and <removed>"
    .replace(/\s+and\s+/gi, "")
    .replace(/\s+or\s+/gi, "")    // " or <removed>"
    .replace(/\s+or\s+/gi, "")
    .replace(/,?\s*/g, "")        // any sentinel with optional comma before
    .replace(/,\s*,/g, ",")        // collapsed double commas
    .replace(/\s+([.,])/g, "$1")   // space before punctuation
    .replace(/\bUse:\s*$/gim, "")  // dangling "Use:" with nothing after
    .replace(/[ \t]{2,}/g, " ")    // runs of spaces
    .replace(/[ \t]+$/gm, "")      // trailing spaces per line
    .trim();
}

// --- Query rewriting ---------------------------------------------------------

const REWRITE_PROMPT = `You are a search query normalizer for the \`bee\` CLI (CloudBees/Jenkins tool).
Convert the user's natural-language question into 3-6 lowercase keyword tokens that a BM25 index can match.
Output ONLY the keywords, space-separated, no punctuation, no explanation.

Examples:
  "Hello I am a newbie, how to use this?" → getting started login auth
  "how do I kick off a pipeline job?" → job run pipeline trigger
  "rotate my api key" → credential update secret rotate
  "put agent into maintenance mode" → node offline
  "I cannot log in, 403 forbidden" → auth error 403 troubleshoot
  "show me all create node options" → node create flags options`;

/**
 * Rewrite a free-form user query into BM25-friendly keywords using the LM.
 * Falls back to the original query on any error — retrieval still works,
 * just without normalization.
 */
async function rewriteQuery(query: string, provider: LMProvider): Promise<string> {
  try {
    const prompt = `${REWRITE_PROMPT}\n\n  "${query}" →`;
    const raw = await provider.generate(prompt);
    const keywords = raw.trim().split(/\s+/).slice(0, 8).join(" ");
    if (keywords.length > 0) return keywords;
  } catch {
    // fall through
  }
  return query;
}


/**
 * A configured language-model backend.
 *
 * `generate(prompt)` receives the full assembled prompt string and must return
 * the model's response text. Throw on hard errors (auth, network); return a
 * string on success (even if the model says "I don't know").
 *
 * `stream(prompt)` is optional — if implemented, the CLI renders the response
 * token-by-token as they arrive from the API. Falls back to `generate()` when
 * not available.
 *
 * `name` is displayed in the `--json` output so users can see which backend
 * is active.
 */
export interface LMProvider {
  readonly name: string;
  generate(prompt: string): Promise<string>;
  stream?(prompt: string): AsyncGenerator<string, void, unknown>;
}

// --- Active provider registry ------------------------------------------------

let _provider: LMProvider | null = null;

/** Register the active LM provider. Call once during plugin/app startup. */
export function setProvider(p: LMProvider | null): void {
  _provider = p;
}

/** Return the active provider, or null when none is configured. */
export function getProvider(): LMProvider | null {
  return _provider;
}

// --- Answer result -----------------------------------------------------------

export type AnswerSource = "lm" | "raw";

export interface AnswerResult {
  /** "lm" when a provider answered, "raw" when falling back to ranked hits */
  source: AnswerSource;
  /** Natural-language answer (lm) or empty string (raw — caller renders hits) */
  text: string;
  /** Ranked hits for fallback rendering / JSON output */
  hits: DocItem[];
  /** Provider name when source="lm", undefined otherwise */
  provider?: string;
  /** If true, use streamOutput() instead of reading text directly */
  stream?: boolean;
  /** Callback for streaming output — receives tokens as they arrive */
  streamOutput?: (write: (chunk: string) => void) => Promise<string>;
}

// --- Orchestration -----------------------------------------------------------

let _graph: CommandGraph | null = null;

function getGraph(corpus: DocItem[]): CommandGraph {
  if (!_graph) _graph = buildGraphFromCorpus(corpus);
  return _graph;
}

/**
 * Main entry point for `bee ask`.
 *
 * 1. Retrieve hits via BM25/FTS5 with synonym expansion and relevance gate.
 *    Empty result = off-domain query — present a safe no-result message.
 * 2. No provider → raw path (caller renders hits via the presenter).
 * 3. Provider set + non-empty hits → assemble a prompt from the top hits
 *    (not the whole corpus — tight grounding, no leakage) and ask the LM.
 * 4. On provider error, degrade gracefully to the BM25 hits.
 */
export async function answer(
  query: string,
  corpus: DocItem[],
  limit = 5,
): Promise<AnswerResult> {
  const provider = getProvider();
  // softGate rescues ungated hits when the relevance gate empties everything.
  // That is right for the raw fallback (keep `bee ask` useful with no LM), but
  // WRONG on the LM path: there an empty gate is the desired refusal signal —
  // feeding coincidental hits to the model produces confident hallucinations on
  // off-domain queries. So: soft gate only when there is no provider.
  const hits = searchDocs(query, corpus, limit, { gate: true, softGate: true });

  if (!provider || hits.length === 0) {
    return { source: "raw", text: "", hits };
  }

  // Rewrite the query into BM25-friendly keywords so colloquial phrasings
  // ("hello I am a newbie") map to corpus tokens ("getting started login").
  const searchQuery = await rewriteQuery(query, provider);
  if (process.env.BEE_DEBUG_TRACEBACK && searchQuery !== query) {
    process.stderr.write(`[bee ask] rewritten query: ${searchQuery}\n`);
  }

  // ── Multi-stage retrieval pipeline ──────────────────────────────────────
  // BM25 (sparse) + Vector (dense) → RRF fusion → Graph expansion → Reranker
  const bm25Candidates = searchDocs(searchQuery, corpus, limit * 3, { gate: true, softGate: true });

  // Vector search — neural embeddings via @xenova/transformers (optional).
  let fused = bm25Candidates;
  try {
    const vdb = getVectorDb();
    const queryEmb = await embed(searchQuery);
    if (queryEmb) {
      const vectorCandidates = searchVector(queryEmb, vdb, corpus, limit * 3);
      fused = rrfFusion(bm25Candidates, vectorCandidates);
    }
  } catch {
    // Vector search unavailable — fall back to BM25-only.
  }

  // Graph expansion: append related commands from the same group/CRUD family.
  const graph = getGraph(corpus);
  const graphExtra = expandGraph(fused, corpus, graph, 3);
  fused = [...fused, ...graphExtra];

  // LM reranker disabled — BM25+RRF order is already high-quality (98.4%
  // Recall@1) and reranking with a mismatched embedding endpoint corrupts it.
  // ponytail: re-enable when corpus and runtime always share the same embedding endpoint.
  const contextHits = fused.slice(0, limit);

  if (process.env.BEE_DEBUG_TRACEBACK) {
    process.stderr.write(`[bee ask] context hits: ${contextHits.map(h => h.id).join(", ")}\n`);
  }

  const prompt = buildUserPrompt(query, contextHits);

  // Streaming path — caller (CLI) writes chunks as they arrive.
  const streamFn = provider.stream;
  if (streamFn) {
    return {
      source: "lm",
      text: "",
      hits,
      provider: provider.name,
      stream: true,
      streamOutput: async (write: (chunk: string) => void): Promise<string> => {
        const chunks: string[] = [];
        try {
          for await (const chunk of streamFn.call(provider, prompt)) {
            write(chunk);
            chunks.push(chunk);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[bee ask] LM stream error (${provider.name}): ${msg}\n`);
          write("\n");
        }
        // When streaming yielded nothing, fall back to non-streaming
        // (e.g., endpoint returned plain JSON instead of SSE).
        const full = chunks.length > 0 ? chunks.join("") : await provider.generate(prompt);
        if (process.env.BEE_DEBUG_TRACEBACK) {
          process.stderr.write(`[bee ask] LM stream full: ${full.slice(0, 500)}\n`);
        }
        return stripInventedCommands(full, corpus);
      },
    };
  }

  try {
    const raw = await provider.generate(prompt);
    if (process.env.BEE_DEBUG_TRACEBACK) {
      process.stderr.write(`[bee ask] LM raw response: ${raw.slice(0, 500)}\n`);
    }
    const text = stripInventedCommands(raw, corpus);
    return { source: "lm", text, hits, provider: provider.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bee ask] LM error (${provider.name}): ${msg}\n`);
    return { source: "raw", text: "", hits };
  }
}
