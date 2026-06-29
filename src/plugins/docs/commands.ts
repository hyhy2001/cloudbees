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
import { answer, getProvider, stripPreamble as stripPreambleStr } from "./answer";
import { presentAnswer } from "./presenter";
import { renderMarkdown, StreamingMarkdownRenderer, renderStructuredAnswer } from "./render";
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
  // ── bee ask <query> ────────────────────────────────────────────────────────
  ctx.program
    .command("ask")
    .description("Ask how to use bee — requires LM endpoint configured in bee.lm.json or env")
    .argument("<query...>", "What you want to do (e.g. 'create node --host', 'what is a profile')")
    .option("--limit <n>", "Max context items to retrieve", "8")
    .option("--json", "Output machine-readable JSON", false)
    .option("--no-stream", "Disable streaming — collect full response before printing", false)
    .allowUnknownOption()
    .action(async (queryParts: string[], opts: { limit: string; json: boolean; stream: boolean }) => {
      try {
        const cleanParts: string[] = [];
        let jsonFlag = opts.json;
        let limitFlag = opts.limit;
        let streamFlag = opts.stream;
        for (let i = 0; i < queryParts.length; i++) {
          const part = queryParts[i]!;
          if (part === "--json") { jsonFlag = true; continue; }
          if (part === "--no-stream") { streamFlag = false; continue; }
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

        // Spinner runs until first token arrives (answer() returns fast for
        // streaming — actual LM latency is inside streamOutput).
        const stopSpinner = startSpinner("Thinking…");
        const result = await answer(query, corpus, limit);

        if (result.source === "raw" && result.hits.length === 0) {
          stopSpinner();
          printInfo(`INFO No results matched '${query}'. Try 'bee --help' for commands.`);
          return;
        }

        if (jsonFlag) {
          let fullText = result.text;
          if (result.source === "lm" && result.stream && result.streamOutput) {
            const chunks: string[] = [];
            fullText = await result.streamOutput((chunk) => { stopSpinner(); chunks.push(chunk); });
          } else { stopSpinner(); }
          const presented = result.source === "lm"
            ? fullText
            : presentAnswer(query, result.hits).text;
          printMessage(JSON.stringify({
            query,
            source: result.source,
            provider: result.provider ?? null,
            answer: presented,
            structured: result.structured ?? null,
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
          // Structured JSON path (preferred) — deterministic rendering
          if (result.structured) {
            stopSpinner();
            renderStructuredAnswer(result.structured);
            return;
          }
          if (streamFlag && result.stream && result.streamOutput) {
            const renderer = new StreamingMarkdownRenderer(
              (s) => process.stdout.write(s),
            );
            let stopped = false;
            const PREAMBLE_RE = /^(Thinking\.?|We need to|Let me|I need to|I'll|I will|Let's|We'll|We will|To answer|The answer|The user|The question|The request|The context|The instruction|First,?\s+[Ii]|Looking at|Based on the|Okay,?\s+so|Alright,?\s+so|Note:|Step \d|Let's (check|see|verify|think|analyze|consider)|I (should|will|need|must) |We (should|will|need|must) )/i;
            let preBuf = "";
            let preambleDone = false;
            let inThinkTag = false;
            await result.streamOutput((chunk) => {
              if (!stopped) { stopSpinner(); stopped = true; }
              if (preambleDone) { renderer.push(chunk); return; }
              preBuf += chunk;
              // Handle explicit <think>...</think> CoT block
              if (preBuf.includes("<think>")) inThinkTag = true;
              if (inThinkTag) {
                if (preBuf.includes("</think>")) {
                  const after = preBuf.slice(preBuf.indexOf("</think>") + 8).trimStart();
                  preambleDone = true;
                  if (after) renderer.push(after);
                  preBuf = "";
                }
                return; // still inside <think> block
              }
              // Handle implicit preamble
              const inPreamble = PREAMBLE_RE.test(preBuf.trimStart().slice(0, 80));
              if (!inPreamble || preBuf.length > 600) {
                preambleDone = true;
                renderer.push(preBuf);
                preBuf = "";
              } else if (preBuf.includes("\n\n")) {
                const idx = preBuf.lastIndexOf("\n\n");
                const after = preBuf.slice(idx + 2);
                if (after.length > 0 && !PREAMBLE_RE.test(after.trimStart().slice(0, 80))) {
                  preambleDone = true;
                  renderer.push(after);
                  preBuf = "";
                }
              }
            });
            // Flush any remaining buffer (short response, or preamble never ended)
            if (preBuf.length > 0) renderer.push(preambleDone ? preBuf : stripPreambleStr(preBuf));
            if (!stopped) stopSpinner();
            // Stream path may have parsed JSON and set result.structured (model without response_format)
            if (result.structured) {
              renderStructuredAnswer(result.structured);
            } else {
              renderer.flush();
              process.stdout.write("\n");
            }
            return;
          }
          // --no-stream or no stream method: collect full response then render.
          const text = result.text || (result.streamOutput ? await result.streamOutput(() => {}) : "");
          stopSpinner();
          printMessage(renderMarkdown(text));
          return;
        }

        stopSpinner();
        printMessage(presentAnswer(query, result.hits).text);
      } catch (err) {
        printError(String(err instanceof Error ? err.message : err), err);
        process.exit(1);
      }
    });
}
