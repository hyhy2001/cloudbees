/**
 * Docs CLI command — `bee ask <query>`.
 *
 * The command builds one hybrid corpus (live commander tree + generated help
 * facts, plus embedded doc chunks in dev mode) and then chooses between:
 *   - Full-context LM answer when a provider is configured
 *   - Offline ranked hits when no provider is configured or LM call fails
 */

import type { PluginContext } from "../../registry/types";
import { printMessage, printInfo, printError } from "../../core/cli/output";
import { buildCorpus } from "./corpus";
import { answer, getProvider } from "./answer";
import { presentAnswer } from "./presenter";
import { renderMarkdown, StreamingMarkdownRenderer } from "./render";
import chalk from "chalk";

// ─── Spinner ──────────────────────────────────────────────────────────────────

function startSpinner(text: string): () => void {
  if (!process.stdout.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  process.stderr.write("\x1b[?25l"); // hide cursor
  const timer = setInterval(() => {
    process.stderr.write(`\r${chalk.cyan(frames[i++ % frames.length]!)} ${chalk.dim(text)}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stderr.write("\r\x1b[2K"); // clear line
    process.stderr.write("\x1b[?25h"); // restore cursor
  };
}

export function registerDocsCommands(ctx: PluginContext): void {
  ctx.program
    .command("ask")
    .description("Ask how to use bee — requires LM endpoint configured in bee.lm.json or env")
    .argument("<query...>", "What you want to do (e.g. 'create node --host', 'what is a profile')")
    .option("--limit <n>", "Max context items to retrieve", "5")
    .option("--json", "Output machine-readable JSON", false)
    .allowUnknownOption()
    .action(async (queryParts: string[], opts: { limit: string; json: boolean }) => {
      try {
        // passThroughOptions passes unknown --flags into queryParts so users can
        // query "create node --host" without commander treating --host as an error.
        // But it also passes our own --json/--limit through when they appear after
        // the query — re-extract them here so both usages work:
        //   bee ask "create node --host"          → query includes --host
        //   bee ask create node --json            → --json is a flag, not query text
        const cleanParts: string[] = [];
        let jsonFlag = opts.json;
        let limitFlag = opts.limit;
        for (let i = 0; i < queryParts.length; i++) {
          const part = queryParts[i]!;
          if (part === "--json") { jsonFlag = true; continue; }
          if (part === "--limit" && i + 1 < queryParts.length) { limitFlag = queryParts[++i]!; continue; }
          cleanParts.push(part);
        }
        const query = cleanParts.join(" ").trim();
        if (!query) {
          printError("Empty query. Try: bee ask create job");
          process.exit(1);
        }

        if (!getProvider()) {
          printError("bee ask requires an LM provider to be configured. Set LM_URL (and LM_API_KEY or client credentials) in bee.lm.json or environment variables.");
          process.exit(1);
        }

        const parsedLimit = parseInt(limitFlag, 10);
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 5;

        const corpus = buildCorpus(
          ctx.program,
          { includeDocChunks: process.env["BEE_ASK_INCLUDE_DOC_CHUNKS"] === "1" },
        );

        const stopSpinner = startSpinner("Thinking…");
        const result = await answer(query, corpus, limit);
        stopSpinner();

        if (result.source === "raw" && result.hits.length === 0) {
          printInfo(`INFO No results matched '${query}'. Try 'bee --help' for commands.`);
          return;
        }

        if (jsonFlag) {
          // When streaming, collect the full text first.
          let fullText = result.text;
          if (result.source === "lm" && result.stream && result.streamOutput) {
            const chunks: string[] = [];
            fullText = await result.streamOutput((chunk) => chunks.push(chunk));
          }
          const presented = result.source === "lm"
            ? fullText
            : presentAnswer(query, result.hits).text;
          printMessage(JSON.stringify({
            query,
            source: result.source,
            provider: result.provider ?? null,
            answer: presented,
            hits: result.hits.map((h) => ({
              id: h.id,
              type: h.type,
              title: h.title,
              description: h.description,
              source: h.source,
            })),
          }, null, 2));
          return;
        }

        if (result.source === "lm") {
          if (result.stream && result.streamOutput) {
            const renderer = new StreamingMarkdownRenderer(
              (s) => process.stdout.write(s),
            );
            await result.streamOutput((chunk) => renderer.push(chunk));
            renderer.flush();
            process.stdout.write("\n");
            return;
          }
          printMessage(renderMarkdown(result.text));
          return;
        }

        printMessage(presentAnswer(query, result.hits).text);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });
}
