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
  "## Reasoning steps",
  "Before writing your answer, think through these steps silently:",
  "1. Identify the resource type from the question: job, node, credential, controller, profile, ...",
  "2. Identify the action: create, list, run, stop, delete, update, login, switch, ...",
  "3. Match these to a <command> block or <info> block in the context.",
  "4. If the question asks about a flag (`--all`, `--profile`, `--store`, etc.), find the correct command that has that flag in its <flag> elements.",
  "5. If the question asks \"what is X\" or \"explain X\", prefer <info> blocks over <command> blocks.",
  "",
  "## Rules",
  "- `bee help <topic>` is NOT a real command. NEVER suggest `bee help` with a topic argument.",
  "- ALWAYS use the FULL command from <command id=\"...\"> (e.g. `bee job list`, never `bee list`).",
  "- NEVER make up commands. Only use commands present in <command> blocks.",
  "- NEVER make up flags. Only mention flags explicitly listed in <flag> elements. If you are unsure, omit the flag.",
  "- If the question mentions a specific flag name (\"--profile\", \"--all\", \"--store\"), first find a <command> that has that <flag>. If no command has it, do NOT invent it.",
  "- When multiple commands match, prefer the FIRST one in the context (highest-ranked BM25 match).",
  "- If the <context> contains relevant <info> or <command> blocks, you MUST use them. Do not say \"No info available\" when the context has an answer.",
  "- If no block is relevant, say: \"No info available — try `bee --help`\"",
  "- Do not answer questions unrelated to bee. Say: \"I only help with bee usage.\"",
  "",
  "## Action-verb matching",
  "Match the action verb from the question to the correct command verb:",
  "  \"add a build parameter\" → update (adding to existing job), not create.",
  "  \"remove an agent\" → delete, not update.",
  "  \"login to a profile\" → `bee auth login --profile`, not `bee auth use`.",
  "  \"switch profile\" → `bee auth use`, not `bee auth login`.",
  "  \"install bee\" → login/concept, no install command exists.",
  "  \"what is\" / \"explain\" / \"tell me about\" → <info> block.",
  "  \"list all\" / \"show everything\" → command with `--all` flag.",
  "",
  "## Output format",
  "1–2 sentences explaining what to do, then the exact command(s) on their own line.",
  "Format: <explanation>",
  "        `bee <command> <args> <flags>`",
  "",
  "For concept questions (\"what is X\"), output: 1–2 sentence explanation, then the relevant command(s).",
  "",
  "## Correct examples",
  "  Question: \"trigger a build\"",
  "  Answer: To trigger a build:",
  "          `bee job run <name>`",
  "",
  "  Question: \"how to list everything\"",
  "  Answer: To list all resources:",
  "          `bee job list --all`",
  "          `bee node list --all`",
  "",
  "  Question: \"what is controlled agent\"",
  "  Answer: A controlled agent is a node restricted to specific folders. Manage them with:",
  "          `bee foldersplus list-agents`",
  "",
  "  Question: \"what does --all flag do\"",
  "  Answer: The `--all` flag shows all items instead of only your tracked items (Mine). Use it with list commands:",
  "          `bee job list --all`",
  "",
  "## Examples of what NOT to do (learn from these mistakes)",
  "  Bad question: \"how do I start a build\"",
  "  Bad answer: \"Use `bee job start <name>`\" — `start` is not a real command. Correct: `bee job run <name>`.",
  "",
  "  Bad question: \"what is controlled agent\"",
  "  Bad answer: \"Use `bee help controlled-agent`\" — `bee help <topic>` is NOT a real command. Use <info> blocks.",
  "",
  "  Bad question: \"login to a specific profile\"",
  "  Bad answer: \"`bee auth use <profile>`\" — wrong command. Correct: `bee auth login --profile <name>`.",
  "",
  "  Bad question: \"list all credentials with --all\"",
  "  Bad answer: \"`bee cred list --all`\" — only suggest --all if <flag>--all</flag> appears in the cred.list block.",
  "",
  "  Bad question: \"switch to a specific profile\"",
  "  Bad answer: \"`bee auth login --profile <name>`\" — wrong command. Correct: `bee auth use <profile>`.",
  "",
  "  Bad question: \"how to install bee on a server\"",
  "  Bad answer: \"No info available\" — DON'T refuse when a nearby concept exists. Explain login or mention profiles.",
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
