# bee — CloudBees CLI & TUI

`bee` is a tool for operating CloudBees CI / Jenkins controllers, written in TypeScript and compiled to a single standalone binary with [Bun](https://bun.sh). It offers both a scriptable CLI and an interactive terminal UI (TUI) built with [Ink](https://github.com/vadimdemedes/ink) — both share the same service layer, so they see the same session, cache, and tracked-resource state.

- CLI for scripting and automation
- Interactive TUI (`bee --ui`) for day-to-day operation
- Local SQLite for session, cache, and tracked-resource state
- Single self-contained binary (~131 MB) — no runtime required on the target host
- Targets RHEL 8 / glibc ≥ 2.17 (built with `bun-linux-x64-baseline`)

## What It Can Do

- Authentication and **multi-profile** management (log in to several controllers at once, switch the active one)
- Controller discovery and active-controller selection (remembered per profile)
- Job lifecycle: list / get / create / update / delete / run / stop / log / status / copy / move / track / untrack, plus String build parameters, an email anti-spam content filter, and CloudBees Folders Plus controlled-agent approval (list-agents / approve-agent / remove-agent)
- Credential lifecycle: list / get / create / update / delete / track / untrack (system & user stores)
- Node lifecycle: list / get / create / update / delete / offline / online / copy / track / untrack (SSH and JNLP/Inbound launchers, Always/On-demand availability), plus Folders Plus controlled-agent mode toggle
- **Offline help** (`bee ask`) — multi-stage RAG pipeline: BM25 + neural vector search + graph expansion + MiniLM reranker → LM answer generation via any OpenAI-compatible endpoint (disabled until LM endpoint configured)

## Requirements

To **use the pre-built binary** — nothing. Copy `dist/bee` to the target host and run it.

To **build from source**:

- `make` (GNU make)
- Internet access on first build (to download Bun locally into `./.bun`)

## Build & Install

```bash
git clone https://github.com/hyhy2001/cloudbees.git
cd cloudbees
make init          # download bun locally + install deps + compile → dist/bee
```

The binary is written to `./dist/bee`. Copy it anywhere on your `PATH`, or run `make install` to create a `bee.csh` wrapper and symlink it to `~/.local/bin/bee`.

Other useful targets:

```bash
make bun           # install bun locally into ./.bun (auto-runs as needed)
make install       # deps + build + create bee.csh wrapper + ~/.local/bin/bee symlink
make build         # compile dist/bee
make deps          # install dependencies only (bun install)
make dev ARGS='job list'   # run from source without compiling
make run ARGS='job list'   # run the compiled binary
make test          # run tests (bun test)
make typecheck     # type-check with tsc --noEmit
make clean         # remove dist/ and node_modules/
make distclean     # clean + remove the local ./.bun toolchain
```

Bun is installed **locally into `./.bun`** (repo-contained, not system-wide). `make install` also creates a `bee.csh` csh-wrapper in the project root and symlinks it to `~/.local/bin/bee`.

## Where Data Lives

`bee` keeps all local state in a SQLite database. **The DB sits at the project root** when running from the build tree (`dist/bee`), and **next to the binary** when deployed standalone (binary copied elsewhere). The `data/` directory is created lazily on first run.

- **In the build tree** (`dist/bee` with `package.json` in the parent): DB at `<project root>/data/cb.db`. Same database as `make dev` — a login under `make dev` is visible to `dist/bee` and vice-versa. Survives `make clean`.
- **Deployed standalone** (binary copied to another host): DB at `<binary directory>/data/cb.db`. Move the binary, and its data does not follow unless you move `data/` too.
- **Override**: set `CB_DB_PATH` to pin an exact DB file regardless of how `bee` is launched, or `BEE_DIR` to override just the root directory.

## Quick Start

```bash
bee auth login                       # prompts for URL, username, API token
bee controller list
bee controller select <controller-name>
bee job list
bee ask "how do I run a job"         # offline help — no network needed
bee ask "403 error"                  # troubleshooting
bee --ui                             # or drive everything from the TUI
```

## CLI Reference

Global options:

```bash
bee --version        # print version (also -V)
bee --debug          # enable debug logging and full stack traces
bee --ui             # launch the interactive TUI
bee --install        # self-install: create bee.csh wrapper + symlink ~/.local/bin/bee
```

Running `bee` with no subcommand prints help.

### Help (`bee ask`)

Search the built-in help without a network connection:

```bash
bee ask <query>

# Examples
bee ask login
bee ask "create freestyle job"
bee ask "rotate api key"
bee ask "node offline"
bee ask "403 error"
bee ask "what is a credential store"
```

See the [`bee ask` section](#bee-ask--offline-help--natural-language-search) above for full details on retrieval, the LM path, and extending coverage.

### Auth & Profiles (`bee auth`)

A *profile* is a named (controller URL + username + encrypted token). Multiple profiles can be logged in simultaneously; the **active profile** is the one all other commands use.

```bash
# Login and save a profile's session (also makes it active)
bee auth login \
  --url <cloudbees_url> \
  --username <username> \
  --token <api_token> \
  [--profile default]

# Switch the active profile (alias: `switch`)
bee auth use <profile>

# List all profiles (the active one is marked)
bee auth profiles

# Remove a profile's stored token
bee auth logout [--profile <profile_name>]

# Delete a saved profile entirely
bee auth delete --profile <profile_name>
```

The active controller selection is remembered **per profile**, so switching profiles also restores that profile's controller.

### Controller (`bee controller`)

```bash
bee controller list            # all controllers on the CloudBees server
bee controller info <name>     # details + creation permissions
bee controller select <name>   # set active controller (scopes later commands)
bee controller current         # show active controller
```

### Jobs (`bee job`)

```bash
# List tracked jobs (or all jobs on the controller)
bee job list [--all] [--recursive]

# Show job details + config summary
bee job get <name>

# Track one or more existing server jobs (adds to your "Mine" list)
bee job track <name...>

# Stop tracking one or more jobs (removes from "Mine"; does not delete on the server)
bee job untrack <name...>

# Delete one or more jobs/folders
bee job delete <name...> [--yes]

# Clone job configuration
bee job copy <source> <destination>

# Move a job into a different folder ('.' for root)
bee job move <source> <folder>

# Trigger build (optional parameters and wait)
bee job run <name> [-p KEY=value ...] [--wait] [--timeout 120]

# Stop a specific build
bee job stop <name> <build_number>

# Print console log (or stream live)
bee job log <name> [build_number] [-f|--follow]

# Recent build history
bee job status <name> [--count 10]
```

Create jobs:

```bash
# Freestyle
bee job create freestyle <name> \
  [--description <text>] \
  [--shell <command>] \
  [--chdir <directory>] \
  [--node <label_or_node>] \
  [--folder <parent_folder>] \
  [--schedule "<cron_expr>"] \
  [--param-def NAME=default ...] \
  [--email "a@x.com,b@y.com"] \
  [--email-cond success|failed|always|custom] \
  [--email-keyword <keyword> ...] \
  [--email-regex "<regex>"]

# Pipeline — Declarative Pipeline script (file or inline)
bee job create pipeline <name> \
  --script <file_path|inline_string> \
  [--description <text>] \
  [--node <label_or_node>] \
  [--folder <parent_folder>] \
  [--schedule "<cron_expr>"] \
  [--param-def NAME=default ...] \
  [--email "a@x.com,b@y.com"] \
  [--email-cond success|failed|always|custom] \
  [--email-keyword <keyword> ...] \
  [--email-regex "<regex>"]

# Folder
bee job create folder <name> [--description <text>] [--folder <parent_folder>]
```

Pipeline notes:
- `--script` accepts a file path (reads the `.groovy` file) or an inline Groovy string.
- Parameters declared in the script's `parameters {}` block are auto-detected and configured as `ParametersDefinitionProperty`. Use `--param-def` to add extra or override defaults.
- `--node` overrides the `agent` directive in the script (injects `agent { label '...' }`).
- The script is validated against the Jenkins Pipeline Validation API before creation.
- To use inline script: `--script 'pipeline { agent any; stages { stage("Build") { steps { echo "ok" } } } }'`

Update jobs (partial — only the flags you pass change):

```bash
bee job update freestyle <name> \
  [--description <text>] \
  [--shell <command>] \
  [--chdir <directory>] \
  [--node <label_or_node>] \
  [--schedule "<cron_expr>|''"] \
  [--param-def NAME=default ...] \
  [--clear-params] \
  [--email "a@x.com,b@y.com|''"] \
  [--email-cond success|failed|always|custom] \
  [--email-keyword <keyword> ...] \
  [--email-regex "<regex>"] \
  [--clear-email-keywords] \
  [--clear-email-regex]

# Pipeline — update script, node, schedule, email, parameters
bee job update pipeline <name> \
  [--script <file_path|inline_string>] \
  [--description <text>] \
  [--node <label_or_node>] \
  [--schedule "<cron_expr>|''"] \
  [--param-def NAME=default ...] \
  [--clear-params] \
  [--email "a@x.com,b@y.com|''"] \
  [--email-cond success|failed|always|custom] \
  [--email-keyword <keyword> ...] \
  [--email-regex "<regex>"] \
  [--clear-email-keywords] \
  [--clear-email-regex]
```

Pipeline update notes:
- Only the flags you pass are changed; omitted fields stay as-is.
- The script is validated against the Jenkins Pipeline Validation API before applying.
- Parameters are re-parsed from the updated script and merged with any `--param-def` overrides.

String parameters:

- `--param-def NAME=default` is repeatable — each adds one `StringParameterDefinition`.
- `--clear-params` removes all parameters on update.

Email anti-spam content filter (Freestyle):

- `--email-keyword` is repeatable; matches **any** keyword in the build log.
- `--email-regex` matches the build log with a (case-insensitive) regex.
- With both set, the content condition is `keyword_match OR regex_match`.
- Mail is sent only when **both** hold: the email-cond trigger fired (failed/success/always) **and** the content filter matched.
- A filter without a recipient email fails fast.
- The filter is enforced by a Groovy *presend script* embedded in the job; if the build log can't be read in the sandbox, the content filter is skipped (mail is **not** cancelled). An invalid regex disables only the regex part — it never blocks mail.

### Credentials (`bee cred`)

```bash
# List credentials
bee cred list [-o|--output table|json] [--all] [--store system|user]

# Show credential metadata (secrets are never returned by Jenkins)
bee cred get <cred_id> [--store system|user]

# Track one or more existing server credentials
bee cred track <cred_id...> [--store system|user]

# Stop tracking one or more credentials (removes from "Mine"; does not delete on the server)
bee cred untrack <cred_id...> [--store system|user]

# Delete one or more credentials
bee cred delete <cred_id...> [--yes] [--store system|user]

# Create a credential — Username+Password OR SecretText (mutually exclusive)
bee cred create \
  --username <username> \           # Username+Password type
  [--password <password>] \         # prompted if omitted
  [--secret-text <secret>] \        # SecretText type instead (no --username)
  [--id <cred_id>] \                # auto-generated (UUID) if omitted
  [--description <text>] \
  [--scope GLOBAL|SYSTEM] \
  [--store system|user]

# Update a credential (partial)
bee cred update <cred_id> \
  [--username <new_username>] \
  [--password <new_password>] \      # Username+Password credentials
  [--secret-text <new_secret>] \     # SecretText credentials
  [--description <new_description>] \
  [--store system|user]
```

### Nodes (`bee node`)

```bash
# List tracked nodes (or all nodes)
bee node list [--all]

# Show node details
bee node get <name>

# Track one or more existing server nodes
bee node track <name...>

# Stop tracking one or more nodes (removes from "Mine"; does not delete on the server)
bee node untrack <name...>

# Create a node (SSH if --host is given, otherwise JNLP/Inbound)
bee node create <node_name> \
  --remote-dir </path/to/workdir> \
  [--executors 1] \
  [--labels "<space-separated labels>"] \
  [--description <text>] \
  [--host <ssh_host>] \
  [--port 22] \
  [--cred-id <credential_id>] \
  [--java-path </path/to/java>] \
  [--availability always|demand] \
  [--in-demand-delay 0] \
  [--idle-delay 1]

# Update a node (partial — launcher/availability switchable)
bee node update <name> \
  [--description <text>] \
  [--remote-dir </path/to/workdir>] \
  [--executors <n>] \
  [--labels "<space-separated labels>"] \
  [--launcher ssh|jnlp] \
  [--host <ssh_host>] \
  [--port <n>] \
  [--cred-id <credential_id>] \
  [--java-path </path/to/java>] \
  [--availability always|demand] \
  [--in-demand-delay <n>] \
  [--idle-delay <n>] \
  [--controlled-agent true|false]    # Folders Plus controlled-agent mode

# Copy node config
bee node copy <source_name> <new_name>

# Toggle connectivity
bee node offline <name> [--reason <message>]
bee node online <name>

# Delete one or more nodes
bee node delete <name...> [--yes]
```

Availability:

- `always` — keep the agent online as much as possible.
- `demand` — bring online when there's demand, take offline when idle. `--in-demand-delay` / `--idle-delay` (minutes) tune the thresholds.

> Note: the CLI exposes `--java-path` for SSH agents. The TUI omits the Java path field on purpose — CloudBees/Jenkins auto-detects it — and relies on the service-layer default.

### Folders Plus — Controlled Agents (`bee job list-agents` / `approve-agent` / `remove-agent`)

CloudBees Folders Plus allows restricting an agent to only run builds from specific approved folders. `bee` automates the full handshake so you don't need to click through the UI.

**Toggle controlled-agent mode on an agent** (one flag on `node update`, no dedicated subcommand):

```bash
bee node update <agent> --controlled-agent true     # "Only accept builds from approved folders"
bee node update <agent> --controlled-agent false
```

**Manage which agents a folder may run on** (all three live under `bee job`):

```bash
# List agents approved to run builds from a folder
bee job list-agents <folder>

# Run the full approve handshake (enables controlled-agent + key/secret exchange)
bee job approve-agent <folder> <agent>

# Revoke an agent's approval from a folder
bee job remove-agent <folder> <agent> [--yes]

# Examples
bee job approve-agent team MY_AGENT
bee job approve-agent team/backend MY_AGENT
```

`approve-agent` runs the complete 5-step handshake automatically:

1. Enables "Only accept builds from approved folders" on the agent (patches `config.xml`)
2. Creates a controlled-agent request on the folder side → grant ID, read from the `Location` header of the 302 redirect (Request Key)
3. Creates a security token on the agent side → token ID (also from the `Location` header)
4. Authorizes the token with the Request Key → Request Secret
5. Completes the authorization on the folder side with the Request Secret

If any step after step 2 fails, the artifacts already created (the pending grant on the folder, the unassigned token on the agent) are rolled back automatically — best-effort, in reverse order — so a failed handshake leaves nothing dangling.

> **Requires**: admin permissions on both the agent and the folder. The user running `bee` must have access to both sides — this mirrors what the UI requires (two admins exchanging a key/secret).

> **Folders Plus plugin** must be installed on the CloudBees CI instance. This feature is part of the CloudBees Folders Plus enterprise plugin and is not available on open-source Jenkins.

## Tracked Resources ("Mine" vs. "All")

By default `job list`, `node list`, and `cred list` show only resources created or tracked through `bee` (recorded in a local `user_resources` table). Pass `--all` to show everything on the server. The `track` subcommands add a pre-existing server resource to your "Mine" list. Resources tracked locally but missing on the server are shown as `[DELETED_ON_SERVER]`. Tracking is scoped per (resource type, profile, controller).

## Cache

A SQLite TTL cache backs GET calls (controllers, jobs, nodes, credentials — TTLs range 15–300 s by resource type; see [Cache & TTL policy](#cache--ttl-policy-corecache)). Writes automatically invalidate related cache entries.

## TUI

`bee --ui` launches the interactive terminal UI. It requires an interactive terminal (a TTY) and shares the CLI's session/cache/tracked-resource state. The layout auto-scales to the terminal width. On quit, only the TUI's last frame is cleared — your prior scrollback is left intact.

Tabs (one per plugin, contributed via the plugin's optional `screen()`), in order: **Controllers · Nodes · Jobs · Credentials · Info**.

### Layout

```
┌───────────────────────────────────────────────────────────────────────┐
│ 🐝  1:Controllers  2:Nodes  3:Jobs ▾  4:Credentials  5:Info   user@ctrl │  ← tab bar + session
├───────────────────────────────────────────────────────────────────────┤
│ ⚙ Jobs  [MINE]  › /my-folder            ⟳ refreshing…                   │  ← screen header
│ / search…                                                               │  ← search bar (when "/")
│    Status      T   Name              Build#   Description               │
│  ─────────────────────────────────────────────────────────────────────│
│  ▶ ✓  OK       FS  build-api         #42      api service              │  ← cursor row
│    ✗ FAIL      FS  build-web         #17      web bundle               │
│    ◆           FD  my-folder/ ›      —        (drill in with Enter)    │  ← selected (Space)
│                                       3/12  › more below                │
│  ┌─ build-api  #42 ───────────────────────────────────────────────────┐│
│  │ type FS   schedule H 8 * * *   node linux                          ││  ← detail panel
│  └────────────────────────────────────────────────────────────────────┘│
│ ✓  Triggered: build-api                                                 │  ← toast (transient)
├───────────────────────────────────────────────────────────────────────┤
│ [Enter] menu  [ctrl+n] new  [ctrl+d] delete  [/] search  [r] refresh  …  │  ← footer hints
└───────────────────────────────────────────────────────────────────────┘
```

`Enter` on a row opens a numbered **action menu**; the menu is where Run/Edit/Delete/etc. live, so the table itself only needs cursor + Enter:

**Mouse support**: click on tab headings to switch tabs, click on form fields to focus, click on table rows to move cursor, click on context menu items to run actions, click on search bar to start filtering, click on `[MINE]/[ALL]` to toggle scope, click on confirm/cancel buttons in confirmation dialogs. All mouse interactions are disabled when stdout is not a TTY.

```
  list ──Enter──▶ ContextMenu ──pick──▶ action
                       │                   ├─▶ ConfirmModal   (Delete, Stop, Logout)
                       │                   ├─▶ FormModal      (Edit, Run-with-params)
                       └──Esc──▶ list      ├─▶ ParamListEditor / ScheduleBuilder / EmailBuilder
                                           └─▶ LogViewer
```

### Global keys

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Next / previous tab |
| `←` / `→` | Previous / next tab |
| `1`–`9` | Jump straight to tab N |
| `Ctrl+l` | Login (when logged out) |
| `Ctrl+o` | Logout (when logged in; asks to confirm) |
| `Shift+P` | Switch active profile (when more than one) |
| `Shift+L` | Toggle the CLI-equivalent command log pane |
| `?` | Toggle help |
| `Ctrl+q` | Quit |

### Navigation (in any table)

| Key | Action |
|---|---|
| `↑` / `↓` | Move cursor up / down |
| `Home` / `End` | Jump to first / last row |
| `Ctrl+f` / `Ctrl+b` | Page down / up |
| `Space` | Toggle multi-select on the cursor row (where supported) |
| `/` | Search (filter the list); `Esc` clears |
| `Enter` | Open the row's action menu (folders: drill in) |

### Common per-tab keys

| Key | Action |
|---|---|
| `Ctrl+n` | Create a new resource |
| `Ctrl+d` | Delete — the multi-selected rows, or the cursor row |
| `Ctrl+a` | Toggle Mine / All (remembered across launches) |
| `Shift+F` | Toggle auto-refresh |
| `r` | Refresh now |

Edit / Track / Untrack live inside the `Enter` action menu, not as standalone keys.

### Tab-specific keys

| Tab | Key | Action |
|---|---|---|
| Jobs | `Enter` | On a folder: drill in. On a freestyle or pipeline job: open the action menu |
| Jobs | `Backspace` | Go up one folder level |
| Jobs | `c` | Clone the cursor job (freestyle only) |
| Jobs | `m` | Move the cursor job to another folder (freestyle only) |
| Jobs | `A` | Open the Controlled Agents overlay (folders only) |
| Nodes | `Enter` | Action menu (Toggle Offline · Edit · Approve Folder · Track · Untrack · Delete) |
| Credentials | `Shift+S` | Toggle system / user store (a real refetch) |
| Credentials | `Enter` | Action menu (Edit · Track · Untrack · Delete) |
| Controllers | `Enter` | Select the active controller |
| Info | `Ctrl+x` | Clear the local cache |

The Jobs action menu carries: View Log · Run · Stop · Edit · Params · Schedule · Email · Move · Track/Untrack · Delete, plus Controlled Agents on folder rows. Inside the menu, `1`–`9` pick directly, `↑`/`↓` move, `Enter` runs, `Esc` backs out to the list.

Multi-select (toggle rows with `Space`) swaps the single-row keys for bulk ones on the Jobs, Nodes, and Credentials tabs: `i` track · `u` untrack · `Ctrl+d` delete · `Esc` deselect all.

The Nodes "Approve Folder" action and the Jobs "Controlled Agents" overlay both open the same grant list (folders↔agents are two views of the same approval). In that overlay: `↑`/`↓` move · `a` approve · `d` revoke (works on pending grants too) · `r` refresh · `Esc` close.

### Log viewer

`Enter → View Log` on a job opens a live, streaming log pane:

| Key | Action |
|---|---|
| `↑` / `↓` | Scroll one line |
| `Ctrl+f` / `Ctrl+b` | Page down / up |
| `Home` / `End` | Jump to top / bottom (bottom re-pins to live tail) |
| `[` / `]` | Older / newer build |
| `Esc` | Back to the job list |

Capitalised shortcuts (`Shift+P`, `Shift+L`, `Shift+F`, `Shift+S`) take Shift on purpose — it keeps them clear of the lowercase/`Ctrl` keys (e.g. `Shift+F` auto-refresh vs the table's `Ctrl+f` paging). The footer shows them as `[F]`, `[S]`, etc.

Form fields show a short hint on the right. Fields that take a filesystem path (Remote Dir, Working Dir) **Tab-complete against the local machine's filesystem** — this is a convenience for agents on the same host; the typed value is always what gets sent.

Set `BEE_ASCII=1` to force ASCII symbols and borders instead of Unicode (useful on terminals with limited glyph support).

## `bee ask` — Offline Help & Natural-Language Search

`bee ask` answers questions about how to use `bee` with a multi-stage RAG pipeline. Only the answer generator needs an external LM — everything else runs locally.

```
User query
  → BM25 (FTS5, 84 items, top-15)
     Synonym expansion (100+ domain synonyms), relevance gate.
  → Neural Vector Search (MiniLM, 384-dim, top-15)
     Pre-computed corpus embeddings bundled in binary.
  → RRF Fusion (k=60)
     Reciprocal Rank Fusion: BM25 + Vector results merged.
  → Graph Expansion (+3 CRUD neighbors)
     Same-group and same-resource commands.
  → MiniLM Reranker (local, free)
     Cosine similarity between query and each hit's corpus vector.
  → Top-5 → Prompt → LM Generator (API, 1 call)
```

**1 API call per query** (generator only). Retrieval, vector search, graph, and reranker are all local via the bundled embedding model (MiniLM by default, configurable via `embedding_model` in `bee.lm.json` or `CB_EMBEDDING_MODEL` env var).

### Retrieval components

**BM25 / FTS5** (`corpus.ts`) — SQLite FTS5 search with synonym expansion (100+ hand-maintained domain synonyms + 111 build-time LLM-generated synonyms merged with priority), column weights (title×10, description×5, body×1), exact command-path promotion, and a word-start relevance gate (≥60% coverage). Generated synonyms are pruned (no self-references or multi-word entries) and guarded by a reserved-token blocklist. Hand-maintained entries always win over generated ones.

### Adding help facts

Help facts live in `scripts/generate-help-index.ts`. Each fact has:

```typescript
{
  id: "concept.my-topic",
  kind: "concept" | "troubleshooting",
  title: "short noun phrase",
  terms: ["synonym1", "user phrasing 2", ...],  // extra BM25 vocabulary
  answer: "One or two sentence prose answer.",
  commands: ["bee plugin subcommand <arg>", ...],
  related: ["bee other subcommand", ...],
}
```

After editing the script, regenerate:

```bash
bun run scripts/generate-help-index.ts   # writes src/generated/help-index.ts
```

The generated file is committed and baked into the binary.

### BM25 + LLM benchmark

`scripts/benchmark.ts` is a comprehensive quality harness with **498 ground-truth queries** (121 hand-curated + 377 auto-generated from the corpus, quality-filtered to remove template artifacts) that covers every query type: exact command name, natural-language paraphrase, concept/definition, troubleshooting, flag-specific, and cross-plugin. It has two phases:

**Phase A — BM25 retrieval** (fast, no LLM): scores each query against the real corpus using Recall@1 / Recall@3 / Recall@5 / MRR, with a breakdown by query type and a miss table showing the top competing hit.

**Phase B — LLM answer quality** (requires LM server): uses the role-separated prompt (`SYSTEM_PROMPT` + `buildUserPrompt`) and scores answers with rule-based checks — no self-judge:
- `correct_command` — does the answer mention the expected command (or any context command for concept/troubleshoot queries)?
- `hallucination` — does the answer invent a `bee X` command that was not in the retrieved context?
- `has_flag` — for flag-specific queries, does the answer cite the required flag?
- `wrong_refusal` — does the model say "No info available" when the context actually has an answer?

```bash
bun run scripts/benchmark.ts                # Phase A + B (requires LM endpoint)
bun run scripts/benchmark.ts --no-llm       # Phase A only (fast, no LM needed)
bun run scripts/benchmark.ts --lm-url http://host:port   # custom LM endpoint
bun run scripts/benchmark.ts --api-key <key>              # API key for authenticated endpoints
bun run scripts/benchmark.ts --model <name>               # Model name (default: configured model)
bun run scripts/benchmark.ts --llm-limit 73               # Phase B on first N queries only
```

Results are printed to the console and written to `benchmark-report.md` (gitignored).

**Latest results** (73 LLM queries judged, 1 API call, everything else local):

| Metric | Score |
|---|---|
| BM25 Recall@1 | **76.1%** (379/498) |
| BM25 Recall@3 | **97.4%** (485/498) |
| BM25 Recall@5 | **99.2%** (494/498) |
| BM25 MRR | **0.865** |
| BM25 misses (top-10) | **1** |
| Reranker | MiniLM bi-encoder (local, free, bundled) |
| Vector search | all-MiniLM-L6-v2 384-dim (local, bundled) |
| Graph expansion | CRUD neighbors auto-derived from command tree |
| Synonym expansion | 100+ hand-maintained + 111 build-time LLM-generated (filtered, priority-guarded) |
| API calls | **1** (generator only) |
| LLM correct command | **100.0%** (73/73) |
| LLM hallucination rate | **0.0%** (0/73) |
| LLM has required flag | **100.0%** (12/12) |
| LLM wrong refusal | **0.0%** (0/73) |

LLM by query type:

| Type | N | Correct | No-Hall. | Flag OK |
|------|---|---|---|--------|
| natural | 29 | 100.0% | 100.0% | 100.0% |
| concept | 23 | 100.0% | 100.0% | — |
| troubleshoot | 9 | 100.0% | 100.0% | — |
| flag | 12 | 100.0% | 100.0% | 100.0% |

Recent improvements:
- **Synonym generation**: `scripts/generate-synonyms.ts` uses the LM at build time to produce 111 filtered synonyms (self-references, multi-word entries, and reserved tokens removed). Hand-maintained `SYNONYMS` in `corpus.ts` always win over generated ones.
- **System prompt**: added negative examples for `switch server`→`controller select`, `change freestyle job`→`job update freestyle`, `delete --yes`, and concept answers must show relevant commands.
- **Corpus promotion**: intent pattern `switch (server|controller)` routes to `controller.select`.
- **Benchmark scoring**: fixed `extractMentionedCommands` to capture `bee --ui` and filter false positives via command-group whitelist. Fixed ground truth for `auth use` (positional arg, not `--profile` flag).
- **Query quality**: auto-generated queries cleaned from 798→377 — removed "i want to", "can i", "i need to" variants, "X option Y" artifacts, dot-containing queries, and nested concept questions ("what is how to...").

Pipeline refinements:
- **API calls reduced**: 3 → **1** (expansion and reranker now local via MiniLM)
- **Reasoning model support**: `content` + `reasoning_content` field parsing for DeepSeek/QwQ
- **Graph Expansion**: CRUD neighbors auto-derived from command tree
- BM25 retrieval: Recall@1 **+7.3%**, MRR **+0.054** (promotion layer for flag/cross-plugin/expert routing, synonym map expansion, corpus caching)
- LM latency: streaming output via SSE, timeout increased 15s → 60s
- Output hardening: XML-formatted context, stricter flag anti-hallucination in system prompt, `stripInventedCommands` post-processor (backtick + plain-text), off-domain guard (skip LM if gate rejects query)
- Benchmark: expanded from **69 → 498 queries** (121 curated + 377 quality-filtered auto-generated), **1 miss** in top-10
- LLM correct command: improved from 87.5% → **100.0%** (system prompt hardening, scorer fixes, ground-truth corrections, corpus promotion patterns, synonym generation)
- `bee ask` disabled when no LM provider configured — prints actionable error message pointing to `bee.lm.json` or env vars
- Benchmark script: API key, model name, and limit flags (`--api-key`, `--model`, `--llm-limit`); `stream: false` support for non-streaming endpoints
- Synonym generation: build-time LLM produces 111 filtered synonym entries merged with hand-maintained map at runtime

BM25 Recall@1 by query type:

| Type | N | Recall@1 | Recall@3 | Recall@5 | MRR |
|---|---|---|---|---|---|---|
| exact | 59 | 83.1% | 98.3% | 98.3% | 0.909 |
| natural | 300 | 67.0% | 96.7% | 99.7% | 0.815 |
| concept | 146 | 75.3% | 96.6% | 98.6% | 0.860 |
| troubleshoot | 27 | 88.9% | 100.0% | 100.0% | 0.944 |
| flag | 382 | 73.6% | 96.3% | 99.0% | 0.845 |
| cross-plugin | 5 | 20.0% | 40.0% | 60.0% | 0.370 |

### RAG-vs-LLM ablation

`scripts/ablation.ts` answers a different question than the benchmark: **does the LLM earn its cost over bare retrieval, and is the gap real?** It runs four arms on the same query set — A0 RAG-top1, A1 RAG-top3, A2 LLM+context, A3 LLM closed-book — and reports decision-grade statistics:

- **nDCG@5** — graded retrieval ranking (rewards the primary command ranked first, partial credit for acceptable alternatives), surfacing rank quality that Recall@k hides.
- **Paired bootstrap CI** (5000 resamples) on the A2−A1 accuracy delta — effect size with uncertainty, complementing McNemar's significance test.
- **Net decision accuracy** — folds answer-when-should and refuse-when-should into one number, so confident off-domain answers are punished.

```bash
bun run scripts/ablation.ts --runs 3           # all arms (requires LM)
bun run scripts/ablation.ts --no-llm           # RAG arms + nDCG only (fast)
bun run scripts/ablation.ts --lm-url http://host:port
```

Latest run: nDCG@5 **0.895**, A2 net decision accuracy **87.3%** vs A1 RAG-top3 **65.8%** (current A1: **76.5%** with improved retrieval), grounding lifts the model **87.3 pts** over closed-book (p<0.0001). Report written to `ablation-report.md` (gitignored).

### BM25 retrieval quality (legacy audit)

Measured against a 310-query audit suite covering all plugins, sub-options, natural-language phrasings, concept questions, and troubleshooting:

| Suite | hit@1 | hit@3 |
|---|---|---|
| Cross-plugin (92 queries) | 93 % | 100 % |
| Natural language (118 queries) | 90 % | 96 % |
| Sub-option / flag queries (100 queries) | 85 % | 98 % |

Remaining misses are structural (BM25 parent-group nodes scoring above sub-commands) or intentional (concept facts surfacing for "what is X" queries, which then list the relevant commands anyway).

### Extending synonym coverage

Edit the `SYNONYMS` map in `src/plugins/docs/corpus.ts`. Each entry maps one user token to one canonical token — expansion is additive (original token + synonym are both OR-joined into the FTS5 MATCH expression):

```typescript
kick:        "run",      // "kick off a build" → job run
maintenance: "offline",  // "maintenance mode" → node offline
existing:    "update",   // "add X to existing job" → job update
```

Run the audit scripts to verify the change does not regress other queries:

```bash
bun run scripts/rag-eval.ts       # structured eval over the test corpus (legacy)
bun run scripts/benchmark.ts      # comprehensive BM25 + LLM benchmark (recommended)
bun run scripts/ablation.ts --no-llm   # RAG arms + nDCG@5 (fast regression check)
bun test tests/docs-rag-stress.test.ts
bun test tests/docs-search.test.ts
```

## Architecture & Internals

`bee` is a single TypeScript codebase compiled to one standalone binary. It is built in strict layers — each layer may only import from the ones below it, never sideways or up:

```
  main.ts            entry: initDb → initPlugins → parse argv (or --ui → launchTui)
      │
  registry/          plugin contract + BUILTIN_PLUGINS list + formatter registry
      │
  plugins/           auth · controller · job · node · credential · system · foldersplus
      │   per plugin: commands.ts (CLI) + service.ts (logic), plus screen.tsx (TUI tab)
      │   and xml-builder.ts (config.xml) where that plugin needs them.
│   foldersplus has no standalone CLI — its handshake lives on the
│   node/job services and is driven via `bee job` / `bee node update`
      ▼
  core/              stable engine — NEVER imports plugins/
   ├── api/          HTTP client, CSRF crumb, retry, typed errors
   ├── session/      AES-256-GCM token crypto + per-profile session
   ├── cache/        SQLite TTL cache + per-key TTL policy
   ├── db/           SQLite connection + schema + repositories
   ├── dtos/         server JSON → typed DTO factories
   ├── cli/          output formatters (table/json/kv)
   └── tui/          Ink framework (app, context, keymap, components, data hooks)
      │
  domain/            pure leaf logic — imports NOTHING from core/ or plugins/
                      xml.ts (escaping) · email.ts (presend filter) · schedule.ts (cron) ·
                      pipeline-parse.ts (pipeline script parameter/agent extraction)
```

The same `service.ts` layer backs both the CLI command and the TUI screen for each plugin, so the two front-ends can never drift in behaviour — only in presentation.

### HTTP client (`core/api/client.ts`)

`CloudBeesClientImpl` wraps Bun's global `fetch` and is the single chokepoint for every server call:

- **Auth** — every request carries `Authorization: Basic <base64(user:token)>`.
- **CSRF crumb** — write requests (`POST`/`DELETE`/`postXml`) fetch a Jenkins crumb from `/crumbIssuer/api/json` (cached 5 min, keyed by base URL) and attach it. A `403` invalidates the crumb and retries once with a fresh one.
- **Retry** — GETs retry on 5xx/timeout with exponential backoff `[0, 1, 2, 4]s` (4 attempts), bounded by a **total deadline budget** so retries + sleeps never exceed the client timeout (default 30s) in aggregate.
- **Status mapping** — `401 → AuthError`, `403 → AuthError`, `404 → NotFoundError`, other non-2xx → `APIError`, network failure → `CBConnectionError`. All extend `CBError`; `ValidationError`/`ConfigError` cover bad input and broken local env.
- **Progressive log** — `getProgressiveText()` reads Jenkins' `logText/progressiveText` byte-offset endpoint (`X-Text-Size` / `X-More-Data` headers) so `--follow` and the TUI log viewer stream new bytes instead of re-downloading the whole log.

### Session crypto (`core/session/crypto.ts`)

Tokens are sealed with **AES-256-GCM**. Layout (base64): `[ iv(12) | authTag(16) | ciphertext ]`. The key is `scrypt(secretFile, "bee:" + uid)` — the random 32-byte secret lives in `.bee_secret` (mode `0600`, beside the DB), and the derived key is cached per-process since scrypt is deliberately slow. GCM's auth tag gives integrity, not just confidentiality. See [Security](#security) for the threat model.

### Cache & TTL policy (`core/cache/`)

A SQLite-backed TTL cache fronts GET calls. TTLs are resource-specific (prefix-matched in `policy.ts`), tuned so TUI tab-switches don't refetch needlessly:

| Key prefix | TTL |
|---|---|
| `jobs.list` | 15s |
| `jobs.detail` | 20s |
| `controllers.list` / `.detail` | 60s |
| `controllers.capabilities` | 300s |
| `nodes.*` / `credentials.*` | 30s |
| (default) | 15s |

Writes call `invalidatePrefix(...)` so a create/update/delete drops the stale list entry immediately.

### Plugin contract (`registry/`)

Plugins are registered at **compile time** (no dynamic loading) in `BUILTIN_PLUGINS`. Each `Plugin` exposes:

- `meta` — name, description, version, category.
- `register(ctx)` — attaches commander subcommands and/or formatters. `ctx` hands over the commander `program`, a `getClient()` factory, and the formatter registry — nothing else; plugins import their own services/DTOs directly.
- `screen?()` — optional; returns a `TuiScreen` (id, title, order, icon, Component). Built-in and third-party tabs use the identical contract — there is no privileged path. The TUI collects every `screen()`, sorts by `order`, and renders one tab each.

### Job/Node/Credential config XML

CloudBees/Jenkins configures jobs, nodes, and credentials via `config.xml` POSTs, not a JSON API. Each plugin owns an `xml-builder.ts` that emits the `config.xml` payload; all dynamic values pass through `domain/xml.ts`'s escaper to prevent XML injection. Freestyle email filtering is a Groovy *presend script* embedded in the job XML (`domain/email.ts`); cron schedules become a `TimerTrigger` (`domain/schedule.ts`).

### Database schema (`core/db/schema.sql`)

Four tables, created lazily on first run:

| Table | Holds |
|---|---|
| `profiles` | name, server URL, username, is_default (one row per login profile) |
| `cache` | key → value + `expires_at` (the TTL cache; indexed on `expires_at` for purge) |
| `settings` | key → value (active profile/controller pointers, per-type Mine/All scope) |
| `user_resources` | tracked "Mine" resources, keyed by (type, name, profile, controller) |

Encrypted session tokens live in `settings`, not in a column of their own — the ciphertext is opaque and the secret is outside the DB.

### Build pipeline (`build.ts`)

`bun build --compile` targets `bun-linux-x64-baseline` (no AVX2 requirement → runs on older CPUs / RHEL 8). The version string is injected via `--define BEE_VERSION`. Two non-obvious constraints: bytecode is **off** (Ink's yoga-layout flexbox engine won't compile with it), and the JSX runtime is pinned to production (`jsx`/`jsxs`, not `jsxDEV`) — a dev-runtime build crashes at first render in the compiled binary.

Before compiling, `build.ts` runs code-generation scripts:

1. `scripts/generate-help-index.ts` → `src/generated/help-index.ts` (help facts for `bee ask`)
2. `scripts/generate-embeddings.ts` → `src/generated/embeddings.ts` (neural corpus vectors, 86 KB)
3. `scripts/generate-embedding-model.ts` → `src/generated/embedding-model.ts` (model files, ~31 MB base64, gitignored — regenerated per build; model name from `bee.lm.json`/`CB_EMBEDDING_MODEL`, default `Xenova/all-MiniLM-L6-v2`)
4. `scripts/generate-synonyms.ts` → `src/generated/synonyms.ts` (111 build-time LLM synonym entries, merged with hand-maintained map at runtime)

If a `bee.lm.json` config file (or `CB_*` env vars) is present, the LM credentials are injected via `--define` so the binary carries its own endpoint config. Supported auth: static Bearer token (`CB_API_KEY`) or Databricks OAuth M2M (`CB_CLIENT_ID` + `CB_CLIENT_SECRET`). The build logs which auth method was detected; it never logs the secret itself.

Embedding model auto-switch: set `embedding_model` in `bee.lm.json` to any HuggingFace ONNX model (e.g. `Xenova/multilingual-e5-small`). The build scripts bundle that model's files; `bee ask` uses it for query and reranker embeddings at runtime. When the model bundle fails (no cache), a fallback `MODEL_FILES = {}` is written so compilation always succeeds — the model is downloaded from HuggingFace on first use instead.

## Security

Session tokens are encrypted with **AES-256-GCM**. The key is derived via `scrypt(secret || uid)`, where `secret` is a random 32-byte value stored in `.bee_secret` (next to the DB, `chmod 600`). A leaked DB file alone cannot recover a token — the secret file must also be accessible, and it is readable only by its owner. Mixing the uid into the key means a copied secret file derives a different key under another account. Deleting `.bee_secret` forces re-login.

- API requests use `Authorization: Basic <base64(user:token)>`.
- A CSRF crumb is auto-fetched and attached for all write operations.
- `bee auth logout` clears the active profile's session token.

This is a developer-tool threat model: the OS file permission on `.bee_secret` is the real boundary against other users on the same host.

## Environment Variables

| Variable | Description |
|---|---|
| `CB_DB_PATH` | Override the SQLite DB path (default: `data/cb.db` next to the binary, or the project root when run from source) |
| `BEE_DIR` | Override the root directory used to locate the DB |
| `BEE_DEBUG_TRACEBACK` | Set to `1` to enable debug logging and full stack traces (same as `--debug`) |
| `BEE_ASCII` | Set to `1` to force ASCII symbols/borders in the TUI instead of Unicode |
| `CB_DATABRICK_URL` | LM endpoint base URL |
| `CB_API_KEY` | Static Bearer token / PAT |
| `CB_CLIENT_ID` | OAuth client ID for Databricks M2M |
| `CB_CLIENT_SECRET` | OAuth client secret for Databricks M2M |
| `CB_LM_MODEL` | LM model identifier (e.g. a HuggingFace model name) |
| `CB_EMBEDDING_MODEL` | Embedding model name for vector search (default: `Xenova/all-MiniLM-L6-v2`) |

## Project Structure

```
cloudbees/
├── Makefile
├── build.ts              # Bun compile script → dist/bee
├── bee.csh               # csh wrapper (created by make install)
├── bee.lm.json           # (gitignored) LM endpoint config baked at build time
├── scripts/
│   ├── generate-help-index.ts  # regenerates src/generated/help-index.ts
│   ├── generate-embeddings.ts  # pre-computes neural corpus vectors (MiniLM, 384-dim)
│   ├── generate-embedding-model.ts # bundles MiniLM model files as base64 constants
│   ├── generate-synonyms.ts    # build-time LLM synonym map generator (111 entries)
│   ├── run-benchmark.sh        # non-blocking benchmark runner (progress monitor)
│   ├── benchmark.ts            # comprehensive BM25 + LLM quality benchmark
│   ├── ablation.ts             # RAG-vs-LLM ablation (nDCG, bootstrap CI, net decision acc)
│   └── rag-eval.ts             # BM25 retrieval quality eval (legacy)
├── src/
│   ├── main.ts           # Entry: initDb → initPlugins → parse; --ui → launchTui()
│   ├── generated/
│   │   ├── help-index.ts   # auto-generated help facts (committed)
│   │   ├── embeddings.ts   # pre-computed neural corpus vectors (86 KB, committed)
│   │   ├── embedding-model.ts # MiniLM model files (31 MB base64, gitignored, per-build)
│   │   └── synonyms.ts     # build-time LLM synonym map (111 entries, committed)
│   ├── core/             # Stable engine (never imports plugins/)
│   │   ├── api/          # HTTP client, CSRF crumb, retry, typed errors
│   │   ├── db/           # SQLite connection, schema, repositories/
│   │   ├── cache/        # TTL cache + policy
│   │   ├── session/      # AES-256-GCM session crypto + per-profile session
│   │   ├── dtos/         # DTO interfaces + fromDict factories
│   │   ├── cli/          # output theme/formatters
│   │   ├── client-factory.ts  # getClient() / getActiveController()
│   │   └── tui/          # Ink TUI framework (app, context, keymap, components/, data/)
│   ├── domain/           # Shared leaf logic (never imports core/ or plugins/)
│   │   ├── xml.ts        # escapeXml
│   │   ├── email.ts      # email-ext publisher + anti-spam presend filter
│   │   ├── schedule.ts   # cron model + TimerTrigger XML
│   │   └── pipeline-parse.ts  # pipeline script parameter/agent extraction
│   ├── plugins/          # auth · controller · job · node · credential · system · foldersplus
│   │   └── docs/         # bee ask — BM25 retrieval, presenter, LM provider, config
│   │       └── providers/
│   │           ├── openai.ts      # OpenAI-compatible / static Bearer token
│   │           └── databricks.ts  # Databricks OAuth M2M (client_id + client_secret)
│   └── registry/         # Plugin contract, BUILTIN_PLUGINS, TUI screen collection
└── data/                 # runtime SQLite DB (created next to the binary on first run)
```

## License

MIT
