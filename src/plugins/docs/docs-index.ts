/**
 * Embedded documentation corpus for `bee ask`.
 *
 * The 12 markdown docs under `docs/` are inlined into the bundle/binary at build
 * time via `import ... with { type: "text" }` (the same mechanism schema.sql
 * uses). This is mandatory for the standalone binary: a runtime `fs.readFile`
 * would point into Bun's virtual "/$bunfs" filesystem and fail once compiled.
 *
 * Each file is split into chunks by its `#`/`##` headings so retrieval ranks a
 * specific section ("Mine vs All", "403 errors") rather than a whole long file —
 * BM25 relevance degrades when documents are long and topically mixed.
 */

import indexMd from "../../../docs/index.md" with { type: "text" };
import gettingStartedMd from "../../../docs/getting-started.md" with { type: "text" };
import conceptsMd from "../../../docs/concepts.md" with { type: "text" };
import envVarsMd from "../../../docs/env-vars.md" with { type: "text" };
import troubleshootingMd from "../../../docs/troubleshooting.md" with { type: "text" };
import tuiMd from "../../../docs/tui.md" with { type: "text" };
import authMd from "../../../docs/cli/auth.md" with { type: "text" };
import controllerMd from "../../../docs/cli/controller.md" with { type: "text" };
import askMd from "../../../docs/cli/ask.md" with { type: "text" };
import credMd from "../../../docs/cli/cred.md" with { type: "text" };
import jobMd from "../../../docs/cli/job.md" with { type: "text" };
import nodeMd from "../../../docs/cli/node.md" with { type: "text" };

interface RawDoc {
  /** Display source label, e.g. "concepts.md" or "cli/job.md". */
  source: string;
  content: string;
}

const RAW_DOCS: readonly RawDoc[] = [
  { source: "index.md", content: indexMd },
  { source: "getting-started.md", content: gettingStartedMd },
  { source: "concepts.md", content: conceptsMd },
  { source: "env-vars.md", content: envVarsMd },
  { source: "troubleshooting.md", content: troubleshootingMd },
  { source: "tui.md", content: tuiMd },
  { source: "cli/auth.md", content: authMd },
  { source: "cli/controller.md", content: controllerMd },
  { source: "cli/ask.md", content: askMd },
  { source: "cli/cred.md", content: credMd },
  { source: "cli/job.md", content: jobMd },
  { source: "cli/node.md", content: nodeMd },
];

export interface DocChunk {
  /** Stable-ish id, e.g. "concepts.md#mine-vs-all". */
  id: string;
  /** Source file label. */
  source: string;
  /** The heading text this chunk lives under (empty for a file preamble). */
  heading: string;
  /** Section body (heading line excluded), trimmed. */
  body: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Split one markdown document into chunks at `#` and `##` headings.
 *
 * Fenced code blocks (``` … ```) are tracked so a `# comment` line inside a
 * shell example is NOT mistaken for a heading — the docs are full of those.
 * Deeper headings (`###`+) stay within their parent section.
 */
export function chunkMarkdown(source: string, content: string): DocChunk[] {
  const lines = content.split("\n");
  const chunks: DocChunk[] = [];
  let inFence = false;
  let heading = "";
  let buf: string[] = [];

  const flush = (): void => {
    const body = buf.join("\n").trim();
    if (heading || body) {
      const slug = heading ? slugify(heading) : `section-${chunks.length}`;
      chunks.push({ id: `${source}#${slug || `section-${chunks.length}`}`, source, heading, body });
    }
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence) {
      const m = line.match(/^(#{1,2})\s+(.+?)\s*$/);
      if (m) {
        flush();
        heading = m[2]!;
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return chunks;
}

// Parse once at module load — the docs are static, so there's no reason to
// re-chunk on every `bee ask`.
let _cache: DocChunk[] | null = null;

/** All embedded doc chunks across every file (memoised). */
export function buildDocChunks(): DocChunk[] {
  if (_cache !== null) return _cache;
  _cache = RAW_DOCS.flatMap((d) => chunkMarkdown(d.source, d.content));
  return _cache;
}
