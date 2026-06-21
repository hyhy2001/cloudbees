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
 * Render one DocItem as an XML-like structured block for the LM.
 *
 * XML tags give the LM clear boundaries between items, making it harder to
 * confuse or merge context from different entries. The model sees:
 *   <command id="bee job run">
 *     <usage>bee job run <name></usage>
 *     <desc>...</desc>
 *     <flag>--param</flag>
 *   </command>
 *   <info id="concept.profile">...</info>
 */
export function formatDocItem(item: DocItem): string {
  if (item.type === "doc") {
    const id = item.id ?? (item.source.startsWith("help:") ? item.title ?? item.source : item.source);
    const head = `<info id="${escapeXmlAttr(id)}">`;
    const body = stripTermsFromBody(item.body);
    return body ? `${head}\n${body}\n</info>` : `${head}\n</info>`;
  }

  const lines: string[] = [];
  lines.push(`<command id="${escapeXmlAttr(item.title)}">`);
  if (item.description) lines.push(`  <desc>${escapeXmlAttr(item.description)}</desc>`);
  if (item.body) {
    const bodyLines = item.body.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    const flags = bodyLines.filter((l) => l.trimStart().startsWith("-"));
    if (flags.length > 0) {
      for (const f of flags) {
        const flagName = f.trimStart().split(/\s+/)[0] ?? f.trimStart();
        lines.push(`  <flag>${escapeXmlAttr(flagName)}</flag>`);
      }
    }
  }
  lines.push(`</command>`);
  return lines.join("\n");
}

/** Minimal XML attribute escaping. */
function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  "Answer ONLY from the <command> and <info> blocks in the context below.",
  "",
  "Rules:",
  "- ALWAYS use the FULL command name as shown in <command id=\"...\"> (e.g. `bee job list`, never `bee list`).",
  "- NEVER make up commands. Only use commands present in <command> blocks.",
  "- NEVER make up flags. Only mention flags listed in <flag> elements. If you are unsure about a flag, omit it.",
  "- If no <command> or <info> block is relevant, say: \"No info available — try `bee --help`\"",
  "- Do not answer questions unrelated to bee. Say: \"I only help with bee usage.\"",
  "",
  "Output format: 1–2 sentences explaining what to do, then the exact command(s) on their own line.",
  "Format: <explanation>",
  "        `bee <command> <args> <flags>`",
  "",
  "Example outputs:",
  "  To list all jobs on the current controller:",
  "  `bee job list --all`",
  "",
  "  A profile stores your login for one CloudBees server. Switch profiles with:",
  "  `bee auth use <profile>`",
  "",
  "  If you get a 403 error, check your permissions and active controller:",
  "  `bee controller current`",
  "  `bee auth profiles`",
  "",
  "Examples of what NOT to do:",
  "  Bad question: \"what is the capital of France\"",
  "  Bad answer: \"I only help with bee usage.\"",
  "  (Do not answer questions unrelated to bee.)",
  "",
  "  Bad question: \"how do I start a build\"",
  "  Bad answer: \"Use `bee job start <name>`\"",
  "  (Correct answer: \"Use `bee job run <name>`\")",
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
    "<context>",
    context,
    "</context>",
    "",
    `Question: ${query}`,
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
