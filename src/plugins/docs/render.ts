/**
 * Minimal markdown → terminal renderer for `bee ask` output.
 *
 * Handles the subset the LM actually emits:
 *   - `code` and ```code blocks``` → green
 *   - **bold** → bold
 *   - - bullet / * bullet → indented with •
 *   - Blank lines → preserved
 *   - Everything else → plain
 *
 * Two modes:
 *   - renderMarkdown(text)         — batch render full string
 *   - StreamingMarkdownRenderer    — incremental char-by-char streaming
 */
import chalk from "chalk";

/** Render inline markdown spans within a line. */
function renderInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => chalk.green(code))
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a: string, b: string) => chalk.bold(a ?? b))
    .replace(/\*([^*]+)\*|_([^_]+)_/g, (_, a: string, b: string) => chalk.italic(a ?? b));
}

/** Render a single line (no block context needed). */
function renderLine(line: string): string {
  const bulletMatch = line.match(/^(\s*)[*-] (.+)$/);
  if (bulletMatch) {
    return `${bulletMatch[1]}${chalk.dim("•")} ${renderInline(bulletMatch[2]!)}`;
  }
  const numMatch = line.match(/^(\s*)(\d+)\. (.+)$/);
  if (numMatch) {
    return `${numMatch[1]}${chalk.dim(`${numMatch[2]}.`)} ${renderInline(numMatch[3]!)}`;
  }
  return renderInline(line);
}

/**
 * Batch render — collect full text then render.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceBuffer: string[] = [];

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!inFence) { inFence = true; fenceBuffer = []; }
      else { out.push(chalk.green(fenceBuffer.join("\n"))); inFence = false; fenceBuffer = []; }
      continue;
    }
    if (inFence) { fenceBuffer.push(line); continue; }
    out.push(renderLine(line));
  }
  if (fenceBuffer.length > 0) out.push(chalk.green(fenceBuffer.join("\n")));
  return out.join("\n");
}

/**
 * Streaming markdown renderer — processes chunks incrementally and writes
 * rendered output as soon as it's safe (i.e., outside an open span/block).
 *
 * Strategy:
 *   - Buffer incoming chunks into a line buffer.
 *   - When a newline arrives, the completed line is safe to render and flush.
 *   - Inside a fenced code block (``` ... ```) accumulate until closing fence.
 *   - The last incomplete line stays buffered until flush() is called at end.
 *
 * Usage:
 *   const r = new StreamingMarkdownRenderer(chunk => process.stdout.write(chunk));
 *   for await (const chunk of stream) r.write(chunk);
 *   r.flush();
 */
export class StreamingMarkdownRenderer {
  private buf = "";          // current incomplete line
  private inFence = false;
  private fenceBuffer: string[] = [];

  constructor(private readonly write: (s: string) => void) {}

  /** Feed a chunk — renders completed lines immediately. */
  push(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    // Last element is the incomplete line — keep it buffered.
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      this.writeLine(line);
      this.write("\n");
    }
  }

  /** Call after the stream ends to flush the final partial line. */
  flush(): void {
    if (this.buf.length > 0) {
      this.writeLine(this.buf);
      this.buf = "";
    }
    // Flush unclosed fence block
    if (this.fenceBuffer.length > 0) {
      this.write(chalk.green(this.fenceBuffer.join("\n")));
      this.fenceBuffer = [];
      this.inFence = false;
    }
  }

  private writeLine(line: string): void {
    if (/^```/.test(line)) {
      if (!this.inFence) {
        this.inFence = true;
        this.fenceBuffer = [];
      } else {
        this.write(chalk.green(this.fenceBuffer.join("\n")));
        this.fenceBuffer = [];
        this.inFence = false;
      }
      return;
    }
    if (this.inFence) {
      this.fenceBuffer.push(line);
      return;
    }
    this.write(renderLine(line));
  }
}
