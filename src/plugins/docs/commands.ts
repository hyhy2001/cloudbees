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
import { answer } from "./answer";
import { presentAnswer } from "./presenter";

export function registerDocsCommands(ctx: PluginContext): void {
  ctx.program
    .command("ask")
    .description("Ask how to use bee — searches commands and docs (LM answer when configured)")
    .argument("<query...>", "What you want to do (e.g. 'create job', 'what is a profile')")
    .option("--limit <n>", "Max context items to retrieve", "5")
    .option("--json", "Output machine-readable JSON", false)
    .action(async (queryParts: string[], opts: { limit: string; json: boolean }) => {
      try {
        const query = queryParts.join(" ").trim();
        if (!query) {
          printError("Empty query. Try: bee ask create job");
          process.exit(1);
        }

        const parsedLimit = parseInt(opts.limit, 10);
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 5;

        const corpus = buildCorpus(
          ctx.program,
          { includeDocChunks: process.env["BEE_ASK_INCLUDE_DOC_CHUNKS"] === "1" },
        );
        const result = await answer(query, corpus, limit);

        if (result.source === "raw" && result.hits.length === 0) {
          printInfo(`INFO No results matched '${query}'. Try 'bee --help' for commands.`);
          return;
        }

        if (opts.json) {
          const presented = result.source === "lm"
            ? result.text
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
          printMessage(result.text);
          return;
        }

        printMessage(presentAnswer(query, result.hits).text);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });
}
