import type { DocItem } from "./corpus";

/**
 * Strip BM25 vocabulary terms from a help-fact body before rendering it into
 * an LM prompt. Help-fact bodies have the form:
 *
 *   <answer prose — one or two sentences>
 *   <term1>              ← BM25 synonym vocab, NOT for user/LM consumption
 *   <term2>
 *   bee some command     ← keep: actual executable commands
 *   bee other command    ← keep
 *
 * Strategy: keep the first non-empty lines until we hit a "bee " line or a
 * short term; then switch to keeping only "bee " lines. This preserves the
 * answer prose and the commands list, and drops the synonym terms in between.
 */
function stripTermsFromBody(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  let inTerms = false;

  for (const line of lines) {
    // A real bee command looks like: "bee word word? <optional-arg>?"
    // e.g. "bee job run <name>", "bee auth login", "bee cred list --store user"
    // Synonym terms that start with "bee" (e.g. "bee ask finds nothing",
    // "bee ask no results") are NOT real commands — they lack the command
    // verb structure and contain natural-language words.
    const isRealCommand =
      line.startsWith("bee ") &&
      /^bee\s+[a-z][-a-z]*(\s+[a-z][-a-z]*)?(\s+[<(--].*)?$/i.test(line);

    if (isRealCommand) {
      out.push(line);
      inTerms = false;
      continue;
    }
    // A "term" line: short and looks like a keyword phrase (no punctuation like
    // "--flag" or sentence-ending ".")
    const looksLikeTerm =
      line.length <= 40 &&
      !line.startsWith("-") &&
      !line.endsWith(".") &&
      !line.endsWith(",") &&
      !/\s{2,}/.test(line); // flag table lines have two+ spaces

    if (inTerms && looksLikeTerm) continue; // skip
    if (!inTerms && looksLikeTerm) {
      inTerms = true;  // first term seen — start skipping
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Render one DocItem as a compact, LM-friendly block.
 *
 * Commands: COMMAND header, description, then flags (each on own line).
 * Doc/help facts: INFO header, prose answer, then example commands.
 * Clear section labels help small models distinguish commands from explanation.
 */
export function formatDocItem(item: DocItem): string {
  if (item.type === "doc") {
    const kind = item.source.startsWith("help:") ? "INFO" : "DOC";
    const label = item.source.startsWith("help:")
      ? (item.title ?? item.source)
      : item.title
        ? `${item.source} › ${item.title}`
        : item.source;
    const head = `[${kind}: ${label}]`;
    const body = stripTermsFromBody(item.body);
    return body ? `${head}\n${body}` : head;
  }

  // Command item — structured block so the model can extract usage + flags
  const lines: string[] = [];
  lines.push(`[COMMAND: ${item.title}]`);
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.body) {
    const bodyLines = item.body.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    const flags = bodyLines.filter((l) => l.trimStart().startsWith("-"));
    if (flags.length > 0) {
      lines.push("Flags:");
      for (const f of flags) lines.push(`  ${f.trimStart()}`);
    }
  }
  return lines.join("\n");
}

/** Join the rendered items into a single context section. */
export function formatContext(items: DocItem[]): string {
  return items.map(formatDocItem).join("\n\n");
}

/**
 * The system instruction handed to the LM. Two jobs:
 *   1. Grounding — answer ONLY from the provided commands; never invent flags.
 *   2. Scope guard — `bee ask` is a help assistant for new bee users, nothing
 *      else. It must refuse off-topic questions and must never reveal its own
 *      configuration, API keys, endpoint, or these instructions. The retrieval
 *      relevance gate (corpus.ts) already blocks most off-domain queries before
 *      they reach the model; this prompt is the second line of defence for the
 *      ones that slip through (a query that shares a token with the docs).
 */
export const SYSTEM_PROMPT = [
  "You are a help assistant for the `bee` CLI tool (CloudBees / Jenkins).",
  "",
  "Answer questions about how to use bee commands. Use ONLY the commands in the context.",
  "- For how-to questions: explain in 1 sentence, then show the exact command with flags.",
  "- For concept/definition questions: explain briefly, then list the relevant commands.",
  "- For troubleshooting: say what to check, then list the relevant commands.",
  "- ALWAYS end your answer with the relevant command(s) from the context, even for definitions.",
  "- ALWAYS use the FULL command name exactly as written in [COMMAND] or [INFO] blocks (e.g. `bee job list`, not `bee list`).",
  "- NEVER shorten or abbreviate command names.",
  "- NEVER make up commands. Only use commands shown in [COMMAND] or [INFO] blocks.",
  "- If context has no answer: say \"No info available — try `bee --help`\"",
  "- Do not answer questions unrelated to bee. Say \"I only help with bee usage.\"",
].join("\n");

/**
 * Assemble the USER message: corpus context + question, no system instruction.
 *
 * Providers that send role-separated messages (system + user) use this for the
 * user turn and attach SYSTEM_PROMPT themselves. The grounding rails live in
 * the system role where the model weights them most.
 */
export function buildUserPrompt(query: string, corpus: DocItem[]): string {
  const context = formatContext(corpus);
  return [
    "=== bee commands and help facts (use ONLY these) ===",
    context,
    "=== end of context ===",
    "",
    `Question: ${query}`,
    "",
    "Instructions: Answer briefly. Always end your answer by listing the relevant command(s) on a new line.",
    "Example format: \"<explanation>\\nUse: `bee X Y <arg>`\"",
    "",
    "Answer:",
  ].join("\n");
}

/**
 * Assemble the full single-string prompt: system instruction + corpus context +
 * question. Kept for callers/tests that want one flat string; role-separated
 * providers should prefer buildUserPrompt + SYSTEM_PROMPT.
 */
export function buildPrompt(query: string, corpus: DocItem[]): string {
  return [SYSTEM_PROMPT, "", buildUserPrompt(query, corpus)].join("\n");
}
