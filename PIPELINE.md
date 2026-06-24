# bee ask — RAG Pipeline Architecture

## Overview

`bee ask` answers natural-language questions about the `bee` CLI tool (CloudBees/Jenkins). It uses a hybrid RAG pipeline: retrieval is fully local (BM25 + vector + graph + reranker), and only answer generation calls an external LLM API.

## Pipeline Flow

```
User Query
  ↓
[1] BM25 / FTS5 (SQLite)
    - Corpus: 84 items — 53 commands + 31 help facts
    - Synonym expansion (~100 entries: kick→run, kill→stop, nuke→delete, etc.)
    - FTS5 MATCH with column weights: title×10, description×5, body×1
    - Promotion layer: exact path match, flag-aware, verb+noun patterns, query intent
    - Word-start relevance gate (≥60% coverage)
    - Configurable strict/soft mode — currently uses soft gate on all paths
    - Returns top-15 candidates
  ↓
[2] Vector Search (MiniLM, optional)
    - Model: all-MiniLM-L6-v2 (384-dim, sentence transformer)
    - Bundled in binary: ~23 MB model files as base64 constants
    - Runtime: extracted via env.fs override → ONNX Runtime Web
    - Corpus vectors pre-computed at build time (84 × 384-dim → 86 KB)
    - Query vector computed on the fly (~100ms if model loads)
    - Falls back silently if @xenova/transformers unavailable
    - Returns top-15 candidates
  ↓
[3] RRF Fusion (k=60)
    - Reciprocal Rank Fusion merges BM25 + Vector rankings
    - Formula: score = Σ 1/(k + rank)
    - No training needed, works with any ranking sources
  ↓
[4] Graph Expansion
    - Command graph auto-derived from commander tree
    - Same-group edges: all `job.*` commands connected
    - CRUD resource edges: `job.create.*` ↔ `job.update.*` ↔ `job.delete`
    - Appends up to 3 related commands not already in result set
  ↓
[5] MiniLM Reranker (local, free)
    - Uses same bundled MiniLM model
    - Score for each hit = cosine similarity(query_embedding, hit.vector)
    - re-rank top-15, keep top-5
    - Falls back to BM25 order on any error
  ↓
[6] Prompt Assembly
    - SYSTEM_PROMPT (~40 lines): rules, action-verb matching, negative examples
    - Context: top-5 hits rendered as XML-like blocks:
        <command id="bee job run <name>">
          <desc>Trigger a build</desc>
          <flag>--param</flag>
        </command>
        <info id="concept.profile">...</info>
    - User message: <context>...</context>\nQuestion: {query}\nAnswer:
  ↓
[7] LLM Generate (1 API call)
    - Any OpenAI-compatible endpoint (OpenAI, Databricks, OpenRouter, local llama.cpp)
    - Supports reasoning models (DeepSeek, QwQ) via content/reasoning_content field
    - Parameters: temperature=0, max_tokens=1024, timeout=60s
    - Streaming via SSE, non-streaming also supported
  ↓
[8] stripInventedCommands (defence)
    - Post-processor: validates every `bee <cmd>` against real command tree
    - Removes fake commands, keeps real ones
    - Handles both backtick-wrapped and plain-text mentions
```

## API Calls per Query

**1 API call** (generator only). All retrieval, expansion, vector search, reranking, and graph operations are local.

## Key Metrics (73 queries, oc/deepseek-v4-flash-free)

| Metric | Score |
|--------|-------|
| BM25 Recall@1 | 75.0% (689/919) |
| BM25 Recall@3 | 96.8% (890/919) |
| BM25 MRR | 0.857 |
| Reranker | MiniLM bi-encoder (local, bundled) |
| Vector search | all-MiniLM-L6-v2 (local, bundled) |
| Graph expansion | CRUD neighbors (local) |
| API calls | 1 (generator) |
| Correct command | 94.5% (69/73) |
| Hallucination | 1.4% (1/73) |
| Has required flag | 92.3% (12/13) |
| Wrong refusal | 0.0% (0/73) |

## Corpus

84 items from 3 sources:

1. **Live command tree** (53 items) — auto-derived from Commander.js tree at startup:
   - auth: login, logout, delete, profiles, use
   - controller: list, info, select, current
   - job: list, get, create.*(freestyle|folder|pipeline), delete, copy, move, track, untrack, run, stop, log, status, update.*(freestyle|pipeline), list-agents, approve-agent, remove-agent
   - node: list, get, create, copy, track, delete, offline, online, untrack, update
   - cred: list, get, create, delete, track, update, untrack, create
   - docs: ask

2. **Help facts** (31 items) — hand-authored concepts + troubleshooting:
   - Concepts: profile, controller, credential-store, node-offline, node-delete, job-run-stop, job-history, pipeline, create-pipeline, pipeline-params, mine-vs-all, credential-types, folders, agent-launcher, build-params, controlled-agent, node-labels, getting-started, tui, overview, login, what-is-job, what-is-node, what-is-credential, add-node

3. **Vector embeddings** (86 KB) — pre-computed neural vectors (all-MiniLM-L6-v2, 384-dim) for all corpus items, bundled in binary

## Local Components

### BM25 (corpus.ts, 829 lines)
- SQLite FTS5 with column weights
- Synonym map (~100 entries): kick→run, retire→delete, rotate→update, maintenance→offline, etc.
- Relevance gate: word-start coverage ≥ 60%
- Promotion layer (6 strategies): exact path, expert routing, flag-aware, cross-plugin, verb+noun, intent patterns

### Vector Search (vector.ts, 151 lines)
- Model: all-MiniLM-L6-v2 via @xenova/transformers (ONNX Runtime Web)
- Model files: bundled in binary as base64 constants (31 MB)
- Corpus vectors: pre-computed at build time (84 × 384-dim)
- Query embedding: computed on the fly (~100ms)
- Cosine similarity + top-K

### Graph Expansion (graph.ts, 82 lines)
- Command graph built from corpus IDs
- Same-group edges: auth, controller, job, node, cred
- CRUD edges: create/update/delete/list/run/stop/log on same resource
- Auto-derived, no hand-crafting

### Reranker (rerank.ts, 23 lines)
- Uses same MiniLM as vector search
- Cosine similarity between query embedding and each hit's pre-computed vector
- Pure score + sort — no API call

### Hallucination Defence (3 layers)
1. **stripInventedCommands** — post-processor removes fake `bee <cmd>` 
2. **System prompt** — "answer ONLY from context blocks, never invent"
3. **Relevance gate** — blocks queries with <60% word coverage (soft now)

## Configuration

### LM Provider (bee.lm.json or env vars)
```json
{
  "CB_DATABRICK_URL": "http://127.0.0.1:20128/v1",
  "CB_API_KEY": "sk-...",
  "CB_LM_MODEL": "oc/deepseek-v4-flash-free"
}
```

## Binary

- Size: ~131 MB (includes MiniLM model files)
- Build: `bun build --compile` targets `bun-linux-x64-baseline`
- All-in-one: no runtime dependencies, no external files, fully offline for retrieval

## Known Weaknesses

1. **Synonym map is hand-maintained** — novel vocabulary not covered
2. **Graph doesn't connect sub-resource CRUD** — `job.create.pipeline` not connected to `job.delete` (different resource keys)
3. **MiniLM model may fail to load in compiled binary** — ONNX Runtime Web blob loading issue
4. **No query expansion** — removed because MiniLM zero-shot was unreliable
5. **Single API call is a bottleneck** — if the API is slow/unavailable, no answer
6. **No iterative retrieval** — single-shot RAG, no self-reflection or retrieval loop
7. **Small corpus** (84 items) limits coverage of edge cases
