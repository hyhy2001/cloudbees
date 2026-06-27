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
 * When `related` is true, the block is wrapped in <related>…</related> so the
 * LM sees it as a secondary suggestion, not a primary match.
 */
export function formatDocItem(item: DocItem, related = false): string {
  const inner = item.type === "doc" ? renderInfo(item) : renderCommand(item);
  if (!inner) return "";
  return related
    ? `<related>\n${inner}\n</related>`
    : inner;
}

function renderInfo(item: DocItem): string {
  const id = item.id ?? (item.source.startsWith("help:") ? item.title ?? item.source : item.source);
  const head = `<info id="${escapeXmlAttr(id)}">`;
  const body = stripTermsFromBody(item.body);
  return body ? `${head}\n${body}\n</info>` : `${head}\n</info>`;
}

function renderCommand(item: DocItem): string {
  const lines: string[] = [];
  lines.push(`<command id="${escapeXmlAttr(item.title)}">`);
  if (item.description) lines.push(`  <desc>${escapeXmlAttr(item.description)}</desc>`);
  if (item.body) {
    const bodyLines = item.body.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    const flags = bodyLines.filter((l) => l.trimStart().startsWith("-"));
    if (flags.length > 0) {
      lines.push(`  <flags>`);
      for (const f of flags) {
        // Find the first flag that starts with -- (the primary flag name)
        const tokens = f.trimStart().split(/\s+/);
        const primaryIdx = tokens.findIndex((t) => t.startsWith("--"));
        const flagName = primaryIdx >= 0 ? tokens[primaryIdx]! : tokens[0]!;
        const flagDesc = tokens.slice(primaryIdx + 1).join(" ").trim();
        if (flagDesc) {
          lines.push(`    <flag name="${escapeXmlAttr(flagName)}">${escapeXmlAttr(flagDesc)}</flag>`);
        } else {
          lines.push(`    <flag>${escapeXmlAttr(flagName)}</flag>`);
        }
      }
      lines.push(`  </flags>`);
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
  return items.map((item) => formatDocItem(item)).join("\n\n");
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
  "Before writing your answer, use <think>...</think> to:",
  "  1. Identify which command(s) the question maps to.",
  "  2. Check which flags are relevant.",
  "  3. Choose a concrete realistic example.",
  "Your <think> block is never shown to the user — only what comes after it.",
  "",
  "Rules:",
  "- `bee help <topic>` is NOT a real command. NEVER use `bee help` with a topic argument.",
  "- ALWAYS use the FULL command name shown in <command id=\"...\"> (e.g. `bee job list`, never `bee list`).",
  "- When listing subcommands of a group, list ALL commands from <command> blocks — do not pick a subset. Never invent subcommands. If context is incomplete, say 'run `bee job --help` for a full list'.",
  "- `bee job run` is the command to trigger/execute a build. Always include it when listing job subcommands.",
  "- NEVER omit a space between command args: `bee job move <source> <dest>` not `bee job move <source>.<dest>`.",
  "- NEVER make up commands or flags. Only use commands present in <command> blocks.",
  "- Only mention flags listed in <flag> elements. If unsure about a flag, omit it.",
  "- When multiple commands match, prefer the FIRST one listed (highest-ranked BM25 match).",
  "- If the context has relevant blocks, use them. Do not say \"No info available\" when the context has an answer.",
  "- If nothing is relevant, say: \"No info available — try `bee --help`\".",
  "- Do not answer questions unrelated to bee. Say: \"I only help with bee usage.\"",
  "- When a question asks about a specific command or its options/flags/parameters, ALWAYS show ALL flags in a markdown table with columns: Flag, Description. Never omit flags.",
  "- ALWAYS replace placeholders with realistic concrete values. NEVER output raw <placeholder> syntax.",
  "  ✗ `bee job run <name>` — bad, abstract",
  "  ✓ `bee job run my-pipeline --wait` — good, concrete",
  "- Formatting rules for terminal output:",
  "  - EVERY bee command MUST be wrapped in a fenced code block (```bash ... ```) or inline backticks. NEVER print a bare bee command without backticks.",
  "  - In table cells, NEVER use bare | (breaks rendering). Use 'or' instead.",
  "  - Always quote cron expressions: `'H 0 * * *'` not plain H 0 * * *.",
  "  - Keep table cells short — move long explanations outside the table as prose.",
  "- Answer hierarchically: brief explanation → table of flags → concrete example command.",
  "",
  "Action-verb matching:",
  "  \"add a build parameter\" → `bee job update` (adding to existing), not create.",
  "  \"remove an agent\" or \"remove a credential\" → delete, not update.",
  "  \"login to a specific profile\" → `bee auth login --profile <name>`, not `bee auth use`.",
  "  \"switch to a profile\" → `bee auth use`, not `bee auth login`.",
  "  \"switch jenkins server\" → `bee controller select`, not `bee auth use`.",
  "  \"change a freestyle job\" → `bee job update freestyle`, not generic `bee job update`.",
  "  \"delete X without confirmation\" → include `--yes`, e.g. `bee job delete my-job --yes`.",
  "  \"what is\" / \"explain\" → prefer <info> blocks but ALWAYS show the relevant bee command(s).",
  "",
  "Bad examples (never do these):",
  "  ✗ `bee job start` — `start` is not a command. Use `bee job run`.",
  "  ✗ `bee help controlled-agent` — `bee help <topic>` is NOT a real command.",
  "  ✗ `bee auth use --profile` — wrong. Login to a profile uses `bee auth login --profile`.",
  "  ✗ `bee cred list --all` — only suggest --all if <flag>--all</flag> exists in context.",
  "  ✗ `bee job run --agent` — --agent is not a real flag. Use `--node`.",
  "  ✗ \"No info available\" when context has relevant blocks.",
  "  ✗ `bee node create <name>` — replace <name> with a realistic value like `bee node create linux-builder`.",
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
