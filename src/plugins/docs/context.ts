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
  "Rules:",
  "- `bee help <topic>` is NOT a real command. NEVER use `bee help` with a topic argument.",
  "- ALWAYS use the FULL command name shown in <command id=\"...\"> (e.g. `bee job list`, never `bee list`).",
  "- NEVER make up commands or flags. Only use commands present in <command> blocks.",
  "- Only mention flags listed in <flag> elements. If unsure about a flag, omit it.",
  "- When multiple commands match, prefer the FIRST one listed (highest-ranked BM25 match).",
  "- If the context has relevant blocks, use them. Do not say \"No info available\" when the context has an answer.",
  "- If nothing is relevant, say: \"No info available — try `bee --help`\".",
  "- Do not answer questions unrelated to bee. Say: \"I only help with bee usage.\"",
  "- When a question asks about a specific command or its behaviour, show ALL available flags from the <flags> block with their descriptions.",
  "- Answer hierarchically: start with the command itself, then list relevant flags in detail.",
  "  Example: 'How do I run a job with a specific node and wait?'",
  "    → `bee job run my-pipeline --node linux-agent --wait`",
  "    Then explain: --node restricts to an agent, --wait blocks until the build finishes.",
  "",
  "  Example: 'create a credential'",
  "    → To create a username+password credential:",
  "      `bee cred create --username jenkins --password s3cret --id my-cred`",
  "      Or create a secret-text credential:",
  "      `bee cred create --secret-text 'api-key-123' --id my-token`",
  "",
  "Action-verb matching:",
  "  \"add a build parameter\" → `bee job update` (adding to existing), not create.",
  "  \"remove an agent\" or \"remove a credential\" → delete, not update.",
  "  \"login to a specific profile\" → `bee auth login --profile <name>`, not `bee auth use`.",
  "  \"switch to a profile\" → `bee auth use`, not `bee auth login`.",
  "  \"switch jenkins server\" → `bee controller select`, not `bee auth use`.",
  "  \"change a freestyle job\" → `bee job update freestyle`, not generic `bee job update`.",
  "  \"delete X without confirmation\" → include `--yes` on the specific del command, e.g. `bee job delete <name> --yes`.",
  "  \"switch to a specific profile\" → `bee auth use <profile>` or `bee auth login --profile <name>` WITH the flag.",
  "  \"install bee\" → no install command; explain login.",
  "  \"what is\" / \"explain\" → prefer <info> blocks but ALWAYS show the relevant bee command(s).",
  "    Example: 'What credentials does bee support?' → list types + `bee cred create` for each.",
  "",
  "Output: 1-2 sentences explaining what to do, then the exact command(s) on their own line.",
  "Use CONCRETE examples (replace <placeholder> with a realistic value).",
  "Format: <explanation>",
  "        `bee <command> <example_args> <flags>`",
  "",
  "Examples of good vs bad output:",
  "  ✗ `bee job run <name>` — abstract placeholder",
  "  ✓ `bee job run my-build --wait` — concrete, helpful",
  "  ✗ `bee job run <name> --node <agent>` — all placeholders",
  "  ✓ `bee job run my-pipeline --node linux` — shows real syntax",
  "  ✗ 'Use `bee cred create` with the right options.' — too vague",
  "  ✓ 'Create a username+password credential with:\\n  `bee cred create --username deployer --password s3cret`'",
  "",
  "Examples of full answers:",
  "  To trigger a build:",
  "  `bee job run <name>`",
  "",
  "  A profile stores your login for one CloudBees server. Switch profiles with:",
  "  `bee auth use <profile>`",
  "",
  "Bad examples (learn from these):",
  "  ✗ \"Use `bee job start`\" — `start` is not a command. Use `bee job run`.",
  "  ✗ \"Use `bee help controlled-agent`\" — `bee help <topic>` is NOT a real command.",
  "  ✗ \"`bee auth use --profile`\" — wrong. Login to a profile uses `bee auth login --profile`.",
  "  ✗ \"`bee cred list --all`\" — only suggest --all if <flag>--all</flag> exists.",
  "  ✗ \"`bee job run --agent`\" — --agent is not a real flag. Use `--node` to restrict to an agent.",
  "  ✗ \"No info available\" when context has relevant blocks. Always use them.",
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
