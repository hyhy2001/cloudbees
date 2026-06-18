# `bee ask` Production Plan — Binary-First, All-in-One

## Goal
Make `bee ask` production-ready for standalone binary use:
- works with copied binary only
- needs no source tree, no external `docs/`, no network by default
- never exposes raw internal docs or source structure to end users
- returns exact, short, actionable CLI help

## Current State
Pipeline now:
1. `src/plugins/docs/commands.ts` registers `bee ask`
2. `src/plugins/docs/corpus.ts` builds hybrid corpus from live command tree + embedded markdown doc chunks
3. `searchDocs()` runs local SQLite FTS5/BM25 retrieval with synonym expansion and relevance gate
4. `src/plugins/docs/answer.ts` optionally calls LM provider, else falls back to raw hit dump
5. `src/plugins/docs/docs-index.ts` embeds raw markdown docs into binary

Strengths:
- already binary-safe
- already offline
- retrieval quality already tested heavily

Gaps for production:
- fallback output still exposes doc-oriented/raw retrieval shape
- binary contains raw markdown docs
- user-facing help is search-result dump, not final answer
- LM seam exists, but default UX does not need it

## Target Architecture
Default path:
`embedded help knowledge -> local retrieval -> deterministic presenter -> terminal output`

Optional future path:
`embedded help knowledge -> local retrieval -> grounded LM summarizer (--ai)`

Do not use LLM-only mode.

## Planned Migration
### Phase 1 — Presenter Layer
Add `src/plugins/docs/presenter.ts`.

Responsibilities:
- convert hits into final answer
- never print raw doc chunks or source filenames by default
- produce 3 answer modes:
  - command answer
  - concept/troubleshooting answer
  - no-result answer

Update `src/plugins/docs/commands.ts` to use presenter for non-LM path.
Update `src/plugins/docs/answer.ts` so LM failure falls back to presenter-ready behavior, not raw dump semantics.

### Phase 2 — Replace Raw Markdown Runtime Corpus
Goal: remove raw markdown from runtime help path.

Add build-time generation step:
- input: `docs/`, command metadata, curated concept/troubleshooting entries
- output: `src/generated/help-index.ts`

Proposed shape:
```ts
interface HelpFact {
  id: string;
  kind: "command" | "concept" | "troubleshooting";
  title: string;
  terms: string[];
  answer: string;
  commands?: string[];
  flags?: string[];
  related?: string[];
}
```

Then change retrieval source from raw doc chunks to generated facts.
Keep live command-tree indexing.

### Phase 3 — Retrieval Tuning for Binary UX
In `src/plugins/docs/corpus.ts`:
- preserve command-first ranking for action queries
- add lightweight intent heuristic:
  - action query -> prefer command results
  - concept/error query -> allow concept/troubleshooting facts to lead
- keep synonym map and relevance gate

### Phase 4 — Output Modes
Keep human default minimal.
Add optional:
- `--json` for automation
- `--verbose` for debug/retrieval inspection
- later `--ai` for grounded summary only

`--verbose` may show internal source labels. Default output must not.

## Files to Change
Primary:
- `src/plugins/docs/commands.ts`
- `src/plugins/docs/answer.ts`
- `src/plugins/docs/corpus.ts`
- `build.ts`

Add:
- `src/plugins/docs/presenter.ts`
- `src/generated/help-index.ts`
- build script for help-index generation, likely under `scripts/`

Tests to update/add:
- `tests/docs-answer.test.ts`
- `tests/docs-search.test.ts`
- `tests/docs-rag-stress.test.ts`
- new presenter-focused tests

Docs to update later:
- `docs/cli/ask.md`
- `docs/getting-started.md`
- `docs/index.md`
- `README.md`

## Acceptance Criteria
Production-ready means:
1. `bee ask` works from binary alone
2. default output never prints raw markdown chunks or doc file paths
3. common action queries return exact commands in top answer
4. concept/error queries return short synthesized explanation + related commands
5. no-result path is clear and safe
6. no network required for default behavior
7. test suite covers binary-first behavior

## Recommended Execution Order
1. implement presenter layer first
2. switch default UX away from raw dump
3. add tests for exact output contracts
4. generate help index at build time
5. remove raw markdown from runtime retrieval path
6. add optional `--json`
7. consider `--ai` only after default path is stable
