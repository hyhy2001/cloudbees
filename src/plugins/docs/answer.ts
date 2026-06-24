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
import { rerank } from "./rerank";
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
  for (const item of corpus) {
    if (item.type !== "command") continue;
    valid.add(item.id);
    const dot = item.id.indexOf(".");
    if (dot > 0) valid.add(item.id.slice(0, dot));
  }
  // Always allow ask/help even without commands in corpus.
  valid.add("ask");
  valid.add("help");
  if (valid.size === 0) return text;

  const SENT = "";

  /** Check if `group` (and optional `sub`) is a valid command path. */
  function isValidBeeCmd(group: string, sub?: string): boolean {
    const g = group.toLowerCase();
    const s = sub?.toLowerCase();
    if (g === "ask") return true;
    if (g === "help") return !s; // allow bare "bee help", strip "bee help <topic>"
    const id = s ? `${g}.${s}` : g;
    return valid.has(id);
  }

  // Pass 1: backtick-wrapped commands
  let result = text.replace(/`([^`]*)`/g, (_full, inner: string) => {
    const m = inner.match(/^\s*bee\s+([a-z][-a-z]*)(?:\s+([a-z][-a-z]*))?/i);
    if (!m) return _full;
    return isValidBeeCmd(m[1]!, m[2]) ? _full : SENT;
  });

  // Pass 2: non-backtick commands. Match `bee <group> <sub?>` that appear
  // after a sentence boundary (":", ".", newline, or at string start) and are
  // followed by optional args. This catches "Use bee job list" patterns.
  result = result.replace(
    /(^|[.:;\n])\s*(bee\s+([a-z][-a-z]*)(?:\s+([a-z][-a-z]*))?)/gi,
    (_full, boundary: string, cmd: string, group: string, sub?: string) => {
      return isValidBeeCmd(group, sub) ? _full : `${boundary} ${SENT}`;
    },
  );

  if (!result.includes(SENT)) return text; // nothing invented; return original

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

// --- Provider contract -------------------------------------------------------

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
  const hits = searchDocs(query, corpus, limit, { gate: true, softGate: !provider });

  // Off-domain guard: if the strict gate (no soft rescue) would return empty,
  // the query is likely off-domain. Skip the LM call even when a provider is
  // configured — feeding rescues to a small model produces hallucination.
  if (provider) {
    const strictHits = searchDocs(query, corpus, limit, { gate: true, softGate: false });
    if (strictHits.length === 0 && hits.length > 0) {
      // Gate blocked everything; soft gate rescued it — off-domain query.
      return { source: "raw", text: "", hits };
    }
  }

  if (!provider || hits.length === 0) {
    return { source: "raw", text: "", hits };
  }

  // ── Multi-stage retrieval pipeline ──────────────────────────────────────
  // BM25 (sparse) + Vector (dense) → RRF fusion → Graph expansion → Reranker
  // Fetch extra candidates (3× limit each) so fusion has material to work with.
  const bm25Candidates = searchDocs(query, corpus, limit * 3, { gate: true, softGate: false });

  // Vector search — hash-based bag-of-words, loaded from pre-built file.
  let fused = bm25Candidates;
  try {
    const vdb = getVectorDb();
    const queryEmb = embed(query);
    const vectorCandidates = searchVector(queryEmb, vdb, corpus, limit * 3);
    fused = rrfFusion(bm25Candidates, vectorCandidates);
  } catch {
    // Vector search unavailable — fall back to BM25-only.
  }

  // Graph expansion: append related commands from the same group/CRUD family.
  const graph = getGraph(corpus);
  const graphExtra = expandGraph(fused, corpus, graph, 3);
  fused = [...fused, ...graphExtra];

  // LM reranker: score top candidates, keep top-K.
  const reRanked = await rerank(query, fused.slice(0, 15), (p) => provider.generate(p));
  const contextHits = reRanked.slice(0, limit);

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
        const full = chunks.join("");
        return stripInventedCommands(full, corpus);
      },
    };
  }

  try {
    const raw = await provider.generate(prompt);
    const text = stripInventedCommands(raw, corpus);
    return { source: "lm", text, hits, provider: provider.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bee ask] LM error (${provider.name}): ${msg}\n`);
    return { source: "raw", text: "", hits };
  }
}
