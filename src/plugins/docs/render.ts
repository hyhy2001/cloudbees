/**
 * Minimal markdown → terminal renderer for `bee ask` output.
 *
 * Handles the subset the LM actually emits:
 *   - `code` and ```code blocks``` → green
 *   - **bold** → bold
 *   - - bullet / * bullet → indented with •
 *   - Blank lines → preserved
 *   - Everything else → plain
 */
import chalk from "chalk";

/** Render a single line (no block context needed). */
function renderLine(line: string): string {
  // Bullet list
  const bulletMatch = line.match(/^(\s*)[*-] (.+)$/);
  if (bulletMatch) {
    const indent = bulletMatch[1]!;
    const content = renderInline(bulletMatch[2]!);
    return `${indent}${chalk.dim("•")} ${content}`;
  }

  // Numbered list
  const numMatch = line.match(/^(\s*)(\d+)\. (.+)$/);
  if (numMatch) {
    const indent = numMatch[1]!;
    const num = numMatch[2]!;
    const content = renderInline(numMatch[3]!);
    return `${indent}${chalk.dim(`${num}.`)} ${content}`;
  }

  return renderInline(line);
}

/** Render inline markdown spans within a line. */
function renderInline(text: string): string {
  return text
    // `code` → green
    .replace(/`([^`]+)`/g, (_, code: string) => chalk.green(code))
    // **bold** or __bold__
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a: string, b: string) => chalk.bold(a ?? b))
    // *italic* or _italic_ (single)
    .replace(/\*([^*]+)\*|_([^_]+)_/g, (_, a: string, b: string) => chalk.italic(a ?? b));
}

/**
 * Render markdown text from LM output to terminal-friendly string.
 * Handles fenced code blocks, bullets, inline code/bold.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceBuffer: string[] = [];

  for (const line of lines) {
    // Fenced code block start/end
    if (/^```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceBuffer = [];
      } else {
        // End fence — render accumulated block
        const code = fenceBuffer.join("\n");
        out.push(chalk.green(code));
        inFence = false;
        fenceBuffer = [];
      }
      continue;
    }

    if (inFence) {
      fenceBuffer.push(line);
      continue;
    }

    out.push(renderLine(line));
  }

  // Unclosed fence — render as-is
  if (fenceBuffer.length > 0) {
    out.push(chalk.green(fenceBuffer.join("\n")));
  }

  return out.join("\n");
}
