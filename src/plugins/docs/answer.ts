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
import { buildGraphFromCorpus, expandGraph, type CommandGraph } from "./graph";
import { getVectorDb, searchVector, rrfFusion, embed } from "./vector";
import { CORPUS_MODEL } from "../../generated/embeddings";
import { EMBEDDING_MODEL } from "./config";

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

const REWRITE_PROMPT = `Normalize this bee CLI question to BM25 search keywords (3-6 lowercase tokens). Output ONLY the tokens, space-separated.

Examples:
  "Hello I am a newbie, how to use this?" → getting started login
  "kick off a pipeline" → job run pipeline
  "rotate my api key" → credential update rotate
  "put agent in maintenance" → node offline
  "403 forbidden login error" → auth error 403
  "all options for create node" → node create flags`;

/**
 * Rewrite a free-form user query into BM25-friendly keywords using the LM.
 * Falls back to the original query on any error — retrieval still works,
 * just without normalization.
 */
async function rewriteQuery(query: string, provider: LMProvider): Promise<string> {
  try {
    const prompt = `${REWRITE_PROMPT}\n\n  "${query}" →`;
    const raw = await provider.generate(prompt, 32);
    const keywords = raw.trim().split(/\s+/).slice(0, 8).join(" ");
    if (keywords.length > 0) return keywords;
  } catch {
    // fall through
  }
  return query;
}

/**
 * Matches the opening of a chain-of-thought preamble emitted by thinking models
 * (Qwen3, DeepSeek-R1) before the real answer. Shared by the batch path
 * (stripPreamble) and the streaming path (commands.ts) so both strip the same
 * set — previously two copies drifted apart.
 */
export const PREAMBLE_RE = /^(Thinking\.?|We need to|Let me|I need to|I'll|I will|Let's|We'll|We will|To answer|The answer|The user|The question|The request|The context|The instruction|First,?\s+[Ii]|Looking at|Based on the|Given that|Okay,?\s+so|Alright,?\s+so|Note:|Step \d|Action-verb|Let's (check|see|verify|think|analyze|consider|look|make|provide|give|start)|I (should|will|need|must|can) |We (should|will|need|must|can) )/i;

/**
 * Strip chain-of-thought preamble emitted by thinking models (Qwen3, DeepSeek-R1).
 * These models sometimes put reasoning in the content field before the real answer.
 */
export function stripPreamble(text: string): string {
  // Strip explicit <think>...</think> CoT block first.
  const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trimStart();
  if (stripped.length < text.trimStart().length) return stripped;

  // Fallback: strip implicit reasoning preamble.
  if (!PREAMBLE_RE.test(text.trimStart().slice(0, 80))) return text;
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "") {
      const nextNonEmpty = lines.slice(i + 1).find(l => l.trim() !== "");
      if (nextNonEmpty && !PREAMBLE_RE.test(nextNonEmpty.trimStart().slice(0, 80))) {
        return lines.slice(i + 1).join("\n").trimStart();
      }
    }
  }
  return text;
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
  generate(prompt: string, maxTokens?: number): Promise<string>;
  generateJson?(prompt: string): Promise<{ answer: LmAnswer; usage?: TokenUsage } | null>;
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

/** Structured answer from the LM JSON path. */
export interface LmAnswer {
  reasoning?: string;   // extraction CoT — grounded in context, stripped before render
  explanation: string;
  commands: Array<{
    cmd: string;
    flags?: Array<{ name: string; description: string }>;
    example?: string;
  }>;
  note?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Drop hallucinated/duplicate commands and stray non-flag entries from an LM
 * answer's command list. Shared by the structured-JSON path and the
 * stream-then-parse-JSON path, which validated identically.
 *
 *   - reject `--help` invocations
 *   - dedupe on the command minus its flags
 *   - keep only `bee <group>[ <sub>]` that exist in the corpus (ask/help always ok)
 *   - keep only flag entries whose name starts with `--`
 */
export function validateCommands(
  commands: LmAnswer["commands"],
  corpus: DocItem[],
): LmAnswer["commands"] {
  const validIds = new Set(corpus.filter(c => c.type === "command").map(c => c.id));
  const seenCmds = new Set<string>();
  return commands
    .filter(c => {
      if (c.cmd.includes("--help")) return false;
      const normalized = c.cmd.replace(/\s+--?\S+.*$/, "").trim();
      if (seenCmds.has(normalized)) return false;
      seenCmds.add(normalized);
      const m = c.cmd.match(/^bee\s+([a-z][-a-z]*)(?:\s+([a-z][-a-z]*))?/i);
      if (!m) return false;
      const g = m[1]!.toLowerCase();
      const s = m[2]?.toLowerCase();
      return g === "ask" || g === "help" || validIds.has(g) || (s ? validIds.has(`${g}.${s}`) : false);
    })
    .map(c => ({ ...c, flags: c.flags?.filter(f => f.name.startsWith("--")) ?? [] }));
}

export interface AnswerResult {
  /** "lm" when a provider answered, "raw" when falling back to ranked hits */
  source: AnswerSource;
  /** Natural-language answer (lm) or empty string (raw — caller renders hits) */
  text: string;
  /** Structured answer when JSON path succeeded (preferred over text) */
  structured?: LmAnswer;
  /** Token usage from the LM call */
  usage?: TokenUsage;
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
  const hits = searchDocs(query, corpus, limit, { gate: true, softGate: true });

  if (!provider) {
    return { source: "raw", text: "", hits };
  }

  // Hard-gated hits (no soft fallback) drive both the off-topic check and the
  // retrieval pipeline. With the gate on, emptiness is independent of limit, so
  // this single over-fetched query also answers "did anything pass the gate?".
  const directHits = searchDocs(query, corpus, limit * 3, { gate: true, softGate: false });
  // Off-topic query — nothing passed the hard gate, skip the LM call entirely.
  if (directHits.length === 0) {
    return { source: "raw", text: "", hits: [] };
  }

  // Rewrite the query into BM25-friendly keywords when the original query
  // returns few hits (< 3) — avoids extra LM call on well-formed queries.
  let searchQuery = query;
  if (directHits.length < 3) {
    searchQuery = await rewriteQuery(query, provider);
    if (process.env.BEE_DEBUG_TRACEBACK) {
      process.stderr.write(`[bee ask] rewritten query: ${searchQuery}\n`);
    }
  }

  // ── Multi-stage retrieval pipeline ──────────────────────────────────────
  // BM25 (sparse) + Vector (dense, RRF fusion) → Graph expansion
  const bm25Candidates = directHits.length > 0
    ? directHits
    : searchDocs(searchQuery, corpus, limit * 3, { gate: true, softGate: true });

  // Vector search for RRF fusion — only when runtime model matches corpus model
  // and BM25 top hit is a command (not a concept/info doc which vector often ranks poorly).
  let fused_base = bm25Candidates;
  const runtimeModel = EMBEDDING_MODEL ?? "";
  const modelsMatch = !runtimeModel || runtimeModel === "default" || runtimeModel === CORPUS_MODEL;
  const bm25TopIsCommand = bm25Candidates[0]?.type === "command";
  if (modelsMatch && bm25TopIsCommand) {
    try {
      const vdb = getVectorDb();
      const queryEmb = await embed(searchQuery);
      if (queryEmb && queryEmb.length === vdb.matrix[0]?.length) {
        const vectorCandidates = searchVector(queryEmb, vdb, corpus, limit * 3);
        fused_base = rrfFusion(bm25Candidates, vectorCandidates);
      }
    } catch {
      // Vector search unavailable — fall back to BM25-only.
    }
  }

  // Graph expansion: append related commands from the same group/CRUD family.
  const graph = getGraph(corpus);
  const graphExtra = expandGraph(fused_base, corpus, graph, 10);
  const fused = [...fused_base, ...graphExtra];

  // Group expansion: if 3+ hits share the same top-level group (e.g. "job.*"),
  // include ALL commands from that group — pull from full corpus, not just fused.
  const groupCounts = new Map<string, number>();
  for (const h of fused.slice(0, 10)) {
    const g = h.id.split(".")[0]!;
    groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  }
  const dominantGroup = [...groupCounts.entries()].find(([, n]) => n >= 3)?.[0];
  let contextHits: typeof fused;
  if (dominantGroup) {
    // Pull all group members from full corpus (not just fused) to avoid vector gaps
    const allGroupItems = corpus.filter(h => h.id === dominantGroup || h.id.startsWith(dominantGroup + "."));
    const seen = new Set(allGroupItems.map(h => h.id));
    const rest = fused.filter(h => !seen.has(h.id));
    contextHits = [...fused.filter(h => seen.has(h.id)), ...rest].slice(0, Math.max(limit, allGroupItems.length));
  } else {
    contextHits = fused.slice(0, limit);
  }

  if (process.env.BEE_DEBUG_TRACEBACK) {
    process.stderr.write(`[bee ask] context hits: ${contextHits.map(h => h.id).join(", ")}\n`);
  }

  const prompt = buildUserPrompt(query, contextHits);

  // ── Structured JSON path (preferred) ─────────────────────────────────────
  if (provider.generateJson) {
    try {
      const jsonResult = await provider.generateJson(prompt);
      if (jsonResult) {
        const { answer: structured, usage } = jsonResult;
        const cleanCmds = validateCommands(structured.commands, corpus);
        return { source: "lm", text: structured.explanation, structured: { ...structured, commands: cleanCmds }, usage, hits, provider: provider.name };
      }
    } catch (err) {
      if (process.env.BEE_DEBUG_TRACEBACK) {
        process.stderr.write(`[bee ask] JSON path failed (${provider.name}): ${err instanceof Error ? err.message : err}\n`);
      }
    }
  }

  // Streaming path — caller (CLI) writes chunks as they arrive.
  const streamFn = provider.stream;
  if (streamFn) {
    const result: AnswerResult = {
      source: "lm",
      text: "",
      hits,
      provider: provider.name,
      stream: true,
    };
    result.streamOutput = async (write: (chunk: string) => void): Promise<string> => {
      const chunks: string[] = [];
      // Append JSON instruction so model returns structured output even without response_format
      const jsonPrompt = prompt + "\n\nRespond with JSON only.";
      try {
        for await (const chunk of streamFn.call(provider, jsonPrompt)) {
          chunks.push(chunk);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[bee ask] LM stream error (${provider.name}): ${msg}\n`);
      }
      const full = chunks.length > 0 ? chunks.join("") : await provider.generate(jsonPrompt);
      if (process.env.BEE_DEBUG_TRACEBACK) {
        process.stderr.write(`[bee ask] LM stream full: ${full.slice(0, 500)}\n`);
      }
      // Model may return JSON even without response_format support.
      // Strip <think> block then find first { to handle thinking models.
      const trimmed = stripPreamble(full).replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim();
      if (process.env.BEE_DEBUG_TRACEBACK) {
        process.stderr.write(`[bee ask] stream content (first 200): ${trimmed.slice(0, 200)}\n`);
      }
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart !== -1) {
        try {
          const parsed = JSON.parse(trimmed.slice(jsonStart)) as LmAnswer;
          if (typeof parsed.explanation === "string" && Array.isArray(parsed.commands)) {
            result.structured = { ...parsed, commands: validateCommands(parsed.commands, corpus) };
            return parsed.explanation;
          }
        } catch { /* not JSON, fall through */ }
      }
      const cleaned = stripInventedCommands(trimmed, corpus);
      write(cleaned);
      return cleaned;
    };
    return result;
  }

  try {
    const raw = await provider.generate(prompt);
    if (process.env.BEE_DEBUG_TRACEBACK) {
      process.stderr.write(`[bee ask] LM raw response: ${raw.slice(0, 500)}\n`);
    }
    const text = stripInventedCommands(stripPreamble(raw), corpus);
    return { source: "lm", text, hits, provider: provider.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bee ask] LM error (${provider.name}): ${msg}\n`);
    return { source: "raw", text: "", hits };
  }
}
