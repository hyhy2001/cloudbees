/**
 * Minimal markdown → terminal renderer for `bee ask` output.
 *
 * Handles the subset the LM actually emits:
 *   - `code` and ```code blocks``` → green
 *   - **bold** → bold
 *   - - bullet / * bullet → indented with •
 *   - | tables | → formatted columns
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
    // Italic: require content starts and ends with non-whitespace to avoid
    // matching cron asterisks like "H 0 * * *" → use \S at boundaries.
    .replace(/\*(\S[^*]*\S|\S)\*|_(\S[^_]*\S|\S)_/g, (_, a: string, b: string) => chalk.italic(a ?? b));
}

/** Parse a markdown table row into cells. */
function parseTableRow(line: string): string[] {
  // Escaped pipes \| inside cells must not be treated as column separators.
  // Replace \| temporarily, split, then restore.
  const escaped = line.replace(/\\\|/g, "\x00");
  return escaped.split("|").slice(1, -1).map((c) => c.trim().replace(/\x00/g, "|"));
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function isSeparatorRow(line: string): boolean {
  return isTableRow(line) && /^\|[\s|:-]+\|$/.test(line.trim());
}

/** Strip ANSI escape codes to measure visible string width. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Render a collected markdown table to terminal string. */
function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = rows[0]!.length;
  // Widths based on plain text (before renderInline adds ANSI codes).
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length), 4)
  );
  const lines: string[] = [];
  rows.forEach((row, ri) => {
    const cells = row.map((cell, ci) => {
      const rendered = ri === 0 ? chalk.bold.cyan(renderInline(cell)) : renderInline(cell);
      const pad = widths[ci]! - visibleLength(rendered);
      return rendered + " ".repeat(Math.max(0, pad));
    });
    lines.push("  " + cells.join("  " + chalk.dim("│") + "  "));
    if (ri === 0) {
      lines.push("  " + widths.map((w) => chalk.dim("─".repeat(w))).join("  " + chalk.dim("┼") + "  "));
    }
  });
  return lines.join("\n");
}

/** Render a single line (no block/table context needed). */
function renderLine(line: string): string {
  // Headings
  const h2 = line.match(/^## (.+)$/);
  if (h2) return chalk.bold.cyan(h2[1]!);
  const h1 = line.match(/^# (.+)$/);
  if (h1) return chalk.bold.cyan(h1[1]!);
  const h3 = line.match(/^### (.+)$/);
  if (h3) return chalk.bold(h3[1]!);

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
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (tableRows.length > 0) { out.push(renderTable(tableRows)); tableRows = []; }
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      flushTable();
      if (!inFence) { inFence = true; fenceBuffer = []; }
      else { out.push(chalk.green(fenceBuffer.join("\n"))); inFence = false; fenceBuffer = []; }
      continue;
    }
    if (inFence) { fenceBuffer.push(line); continue; }

    if (isTableRow(line)) {
      if (!isSeparatorRow(line)) tableRows.push(parseTableRow(line));
      continue;
    }
    flushTable();
    out.push(renderLine(line));
  }
  flushTable();
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
  private buf = "";
  private inFence = false;
  private fenceBuffer: string[] = [];
  private tableRows: string[][] = [];

  constructor(private readonly write: (s: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      this.writeLine(line);
      if (!this.inFence && !isTableRow(line)) this.write("\n");
    }
  }

  flush(): void {
    if (this.buf.length > 0) {
      this.writeLine(this.buf);
      this.buf = "";
    }
    this.flushTable();
    if (this.fenceBuffer.length > 0) {
      this.write(chalk.green(this.fenceBuffer.join("\n")));
      this.fenceBuffer = [];
      this.inFence = false;
    }
  }

  private flushTable(): void {
    if (this.tableRows.length > 0) {
      this.write(renderTable(this.tableRows) + "\n");
      this.tableRows = [];
    }
  }

  private writeLine(line: string): void {
    if (/^```/.test(line)) {
      this.flushTable();
      if (!this.inFence) { this.inFence = true; this.fenceBuffer = []; }
      else {
        this.write(chalk.green(this.fenceBuffer.join("\n")));
        this.fenceBuffer = [];
        this.inFence = false;
      }
      return;
    }
    if (this.inFence) { this.fenceBuffer.push(line); return; }

    if (isTableRow(line)) {
      if (!isSeparatorRow(line)) this.tableRows.push(parseTableRow(line));
      return;
    }
    // Skip blank lines between table rows — don't flush mid-table
    if (line.trim() === "" && this.tableRows.length > 0) return;
    this.flushTable();
    this.write(renderLine(line));
  }
}
