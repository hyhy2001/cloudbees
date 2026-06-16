# bee — CloudBees CLI & TUI

`bee` is a tool for operating CloudBees CI / Jenkins controllers, written in TypeScript and compiled to a single standalone binary with [Bun](https://bun.sh). It offers both a scriptable CLI and an interactive terminal UI (TUI) built with [Ink](https://github.com/vadimdemedes/ink) — both share the same service layer, so they see the same session, cache, and tracked-resource state.

- CLI for scripting and automation
- Interactive TUI (`bee --ui`) for day-to-day operation
- Local SQLite for session, cache, and tracked-resource state
- Single self-contained binary (~92 MB) — no runtime required on the target host
- Targets RHEL 8 / glibc ≥ 2.17 (built with `bun-linux-x64-baseline`)

## What It Can Do

- Authentication and **multi-profile** management (log in to several controllers at once, switch the active one)
- Controller discovery and active-controller selection (remembered per profile)
- Job lifecycle: list / get / create / update / delete / run / stop / log / status / copy / move / track / untrack, plus String build parameters, an email anti-spam content filter, and CloudBees Folders Plus controlled-agent approval (list-agents / approve-agent / remove-agent)
- Credential lifecycle: list / get / create / update / delete / track / untrack (system & user stores)
- Node lifecycle: list / get / create / update / delete / offline / online / copy / track / untrack (SSH and JNLP/Inbound launchers, Always/On-demand availability), plus Folders Plus controlled-agent mode toggle

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

`bee` keeps all local state in a SQLite database. **The DB sits next to the binary**: when you run `dist/bee`, the database is created at `<directory containing the binary>/data/cb.db`. The `data/` directory is created lazily on first run (the first command that needs the DB), so a freshly-built binary has no `data/` until you run it.

- **Binary**: `<bin dir>/data/cb.db` — wherever you copied `dist/bee`, the DB lives beside it. Move the binary, and its data does not follow unless you move `data/` too.
- **From source** (`make dev`): the project root is used, so the DB is `./data/cb.db`. This is a *different* database from the binary's, so a login under `make dev` is not visible to `dist/bee` and vice-versa.
- **Override**: set `CB_DB_PATH` to pin an exact DB file regardless of how `bee` is launched, or `BEE_DIR` to override just the root directory.

Because the DB lives next to the binary, the directory you place `dist/bee` in must be **writable** — `data/` and the `.bee_secret` file (see [Security](#security)) are created there.

## Quick Start

```bash
bee auth login                       # prompts for URL, username, API token
bee controller list
bee controller select <controller-name>
bee job list
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

# Track an existing server job as yours (adds to your "Mine" list)
bee job track <name>

# Stop tracking a job (removes from "Mine"; does not delete it on the server)
bee job untrack <name>

# Delete job/folder
bee job delete <name> [--yes]

# Clone job configuration
bee job copy <source> <destination>

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

# Folder
bee job create folder <name> [--description <text>] [--folder <parent_folder>]
```

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
```

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

# Track an existing server credential as yours
bee cred track <cred_id> [--store system|user]

# Stop tracking a credential (removes from "Mine"; does not delete it on the server)
bee cred untrack <cred_id> [--store system|user]

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

# Delete a credential
bee cred delete <cred_id> [--yes] [--store system|user]
```

### Nodes (`bee node`)

```bash
# List tracked nodes (or all nodes)
bee node list [--all]

# Show node details
bee node get <name>

# Track an existing server node as yours
bee node track <name>

# Stop tracking a node (removes from "Mine"; does not delete it on the server)
bee node untrack <name>

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

# Delete a node
bee node delete <name> [--yes]
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
| Jobs | `Enter` | On a folder: drill in. On a freestyle job: open the action menu |
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
      │   foldersplus is a stub (no commands, no tab); its handshake lives on
      │   the node/job services and is driven via `bee job` / `bee node update`
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
                     xml.ts (escaping) · email.ts (presend filter) · schedule.ts (cron)
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

## Project Structure

```
cloudbees/
├── Makefile
├── build.ts              # Bun compile script → dist/bee
├── bee.csh               # csh wrapper (created by make install)
├── src/
│   ├── main.ts           # Entry: initDb → initPlugins → parse; --ui → launchTui()
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
│   │   └── schedule.ts   # cron model + TimerTrigger XML
│   ├── plugins/          # auth · controller · job · node · credential · system · foldersplus
│   └── registry/         # Plugin contract, BUILTIN_PLUGINS, TUI screen collection
└── data/                 # runtime SQLite DB (created next to the binary on first run)
```

## License

MIT
