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
- Job lifecycle: list / get / create / update / delete / run / stop / log / status / copy / import, plus String build parameters and an email anti-spam content filter
- Credential lifecycle: list / get / create / update / delete / import (system & user stores)
- Node lifecycle: list / get / create / update / delete / offline / online / copy / import (SSH and JNLP/Inbound launchers, Always/On-demand availability)

## Requirements

To **use the pre-built binary** — nothing. Copy `dist/bee` to the target host and run it.

To **build from source**:

- [Bun](https://bun.sh) ≥ 1.x
- `make`

## Build & Install

```bash
git clone https://github.com/hyhy2001/cloudbees.git
cd cloudbees
make init          # bun install + compile → dist/bee
```

The binary is written to `./dist/bee`. Copy it anywhere on your `PATH`.

Other useful targets:

```bash
make build         # compile dist/bee (alias used by init)
make dev ARGS='job list'   # run from source without compiling
make run ARGS='job list'   # run the compiled binary
make test          # run tests (bun test)
make typecheck     # type-check with tsc --noEmit
make clean         # remove dist/ and node_modules/
```

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
bee --version        # print version
bee --debug          # enable debug logging and full stack traces
bee --ui             # launch the interactive TUI
```

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
bee job list [--all]

# Show job details + config summary
bee job get <name>

# Track an existing server job as yours (adds to your "Mine" list)
bee job import <name>

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
  [--schedule "<cron_expr>"] \
  [--param-def NAME=default ...] \
  [--email "a@x.com,b@y.com"] \
  [--email-cond success|failed|always] \
  [--email-keyword <keyword> ...] \
  [--email-regex "<regex>"]

# Folder
bee job create folder <name> [--description <text>]
```

Update jobs (partial — only the flags you pass change):

```bash
bee job update freestyle <name> \
  [--description <text>] \
  [--shell <command>] \
  [--node <label_or_node>] \
  [--schedule "<cron_expr>|''"] \
  [--param-def NAME=default ...] \
  [--clear-params] \
  [--email "a@x.com,b@y.com|''"] \
  [--email-cond success|failed|always] \
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
bee cred import <cred_id> [--store system|user]

# Create a Username/Password credential
bee cred create \
  --username <username> \
  [--id <cred_id>] \
  [--password <password>] \
  [--description <text>] \
  [--scope GLOBAL|SYSTEM] \
  [--store system|user]

# Update a credential (partial)
bee cred update <cred_id> \
  [--username-cred <new_username>] \
  [--password <new_password>] \
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
bee node import <name>

# Create a node (SSH if --host is given, otherwise JNLP/Inbound)
bee node create \
  --name <node_name> \
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
  [--idle-delay <n>]

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

## Tracked Resources ("Mine" vs. "All")

By default `job list`, `node list`, and `cred list` show only resources created or imported through `bee` (recorded in a local `user_resources` table). Pass `--all` to show everything on the server. The `import` subcommands add a pre-existing server resource to your "Mine" list. Resources tracked locally but missing on the server are shown as `[DELETED_ON_SERVER]`. Tracking is scoped per (resource type, profile, controller).

## Cache

A SQLite TTL cache backs GET calls (controllers, jobs, nodes, credentials — most 10 s TTL). Writes automatically invalidate related cache entries.

## TUI

`bee --ui` launches the interactive terminal UI. It requires an interactive terminal (a TTY) and shares the CLI's session/cache/tracked-resource state. The layout auto-scales to the terminal width. On quit, only the TUI's last frame is cleared — your prior scrollback is left intact.

Tabs (one per plugin, contributed via the plugin's optional `screen()`): **Controllers · Nodes · Jobs · Credentials · Settings**.

### Global keys

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Next / previous tab |
| `←` / `→` | Previous / next tab |
| `l` | Login (when logged out) |
| `P` | Switch active profile (when more than one) |
| `?` | Toggle help |
| `q` | Quit |

### Navigation (in any table)

| Key | Action |
|---|---|
| `j` / `k` (or `↓`/`↑`) | Move cursor down / up |
| `g` / `G` | Jump to first / last row |
| `Ctrl+f` / `Ctrl+b` | Page down / up |
| `/` | Search (filter the list); `Esc` clears |

### Common per-tab keys

| Key | Action |
|---|---|
| `n` | Create a new resource |
| `e` | Edit the selected resource |
| `i` | Import (track an existing server resource into Mine) |
| `u` | Unimport (remove from Mine) |
| `d` | Delete the selected resource |
| `a` | Toggle Mine / All (remembered across launches) |
| `F` | Toggle auto-refresh |
| `R` | Refresh now |

### Tab-specific keys

| Tab | Key | Action |
|---|---|---|
| Jobs | `Enter` / `l` | Open build-log viewer (`q`/`b`/`Esc` to return) |
| Jobs | `r` / `s` | Run / stop the selected job |
| Jobs | `p` | Edit String parameters (dedicated editor) |
| Jobs | `t` | Edit schedule (visual cron builder) |
| Nodes | `o` | Toggle offline/online |
| Credentials | `S` | Toggle system / user store |
| Controllers | `Enter` / `s` | Select the active controller |

Form fields show a short hint on the right. Fields that take a filesystem path (Remote Dir, Working Dir) **Tab-complete against the local machine's filesystem** — this is a convenience for agents on the same host; the typed value is always what gets sent.

Set `BEE_ASCII=1` to force ASCII symbols and borders instead of Unicode (useful on terminals with limited glyph support).

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
├── src/
│   ├── main.ts           # Entry: initDb → initPlugins → parse; --ui → launchTui()
│   ├── core/             # Stable engine (never imports plugins/)
│   │   ├── api/          # HTTP client, CSRF crumb, retry, typed errors
│   │   ├── db/           # SQLite connection, schema, repositories
│   │   ├── cache/        # TTL cache + policy
│   │   ├── session/      # AES-256-GCM session crypto + per-profile session
│   │   ├── dtos/         # DTO interfaces + fromDict factories
│   │   ├── cli/          # output theme/formatters
│   │   ├── client-factory.ts  # getClient() / getActiveController()
│   │   └── tui/          # Ink TUI framework (app, context, components, data hooks)
│   ├── domain/           # Shared leaf logic (never imports core/ or plugins/)
│   │   ├── xml.ts        # escapeXml
│   │   ├── email.ts      # email-ext publisher + anti-spam presend filter
│   │   └── schedule.ts   # cron model + TimerTrigger XML
│   ├── plugins/          # auth · controller · job · node · credential · system
│   └── registry/         # Plugin contract, BUILTIN_PLUGINS, TUI screen collection
└── data/                 # runtime SQLite DB (created next to the binary on first run)
```

## License

MIT
