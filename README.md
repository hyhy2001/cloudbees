# bee — CloudBees CLI

`bee` is a command-line tool for operating CloudBees CI / Jenkins controllers, written in TypeScript and compiled to a single standalone binary with [Bun](https://bun.sh).

- CLI interface for scripting, automation, and interactive use
- Local SQLite for session, cache, and tracked-resource state
- Single self-contained binary (~92 MB) — no runtime required on the target host
- Targets RHEL 8 / glibc ≥ 2.17 (built with `bun-linux-x64-baseline`)
- Interactive TUI (`bee --ui`) built with [Ink](https://github.com/vadimdemedes/ink)

## What It Can Do

- Authentication and profile management
- Controller discovery and active-controller selection
- Job lifecycle: list / get / create / update / delete / run / stop / log / status / copy
- Credential lifecycle: list / get / create / update / delete (system/user stores)
- Node lifecycle: list / get / create / update / delete / offline / online / copy

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

## Quick Start

```bash
bee auth login
bee controller list
bee controller select <controller-name>
bee job list
```

## CLI Reference

Global options:

```bash
bee --version        # print version
bee --debug          # enable debug logging and full stack traces
bee --ui             # launch the interactive TUI
```

### Auth (`bee auth`)

```bash
# Login and save session/profile
bee auth login \
  --url <cloudbees_url> \
  --username <username> \
  --token <api_token> \
  [--profile default]

# Remove stored token for a profile
bee auth logout [--profile <profile_name>]

# Delete a saved profile
bee auth delete --profile <profile_name>

# List all profiles
bee auth profiles
```

### Controller (`bee controller`)

```bash
# List all controllers on the CloudBees server
bee controller list

# Show details and creation permissions
bee controller info <name>

# Set active controller (scopes subsequent commands)
bee controller select <name>

# Show currently active controller
bee controller current
```

### Jobs (`bee job`)

```bash
# List tracked jobs (or all jobs)
bee job list [--all]

# Show job details + config summary
bee job get <name>

# Delete job/folder
bee job delete <name> [--yes]

# Clone job configuration
bee job copy <source> <destination>

# Trigger build (optional parameters and wait)
bee job run <name> \
  [-p KEY=value ...] \
  [--wait] \
  [--timeout 120]

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
  [--email "a@x.com,b@y.com"] \
  [--email-cond success|failed|always] \
  [--email-keyword <keyword> ...] \
  [--email-regex "<regex>"]

# Folder
bee job create folder <name> [--description <text>]
```

Update jobs:

```bash
# Update Freestyle config
bee job update freestyle <name> \
  [--description <text>] \
  [--shell <command>] \
  [--node <label_or_node>] \
  [--schedule "<cron_expr>|''"] \
  [--email "a@x.com,b@y.com|''"] \
  [--email-cond success|failed|always] \
  [--email-keyword <keyword> ...] \
  [--email-regex "<regex>"] \
  [--clear-email-keywords] \
  [--clear-email-regex]
```

Email anti-spam filter behavior (Freestyle):

- `--email-keyword` is repeatable; matches **any** keyword in console output.
- `--email-regex` matches console output with a case-insensitive regex.
- If both keyword and regex are provided, the send condition is `keyword_match OR regex_match`.
- Mail is sent only when: `(email-cond trigger) AND (content filter match)`.
- If a filter is provided without a valid recipient email, the command fails fast.

### Credentials (`bee cred`)

```bash
# List credentials
bee cred list \
  [-o|--output table|json] \
  [--all] \
  [--store system|user]

# Show credential metadata (secrets masked)
bee cred get <cred_id> [--store system|user]

# Create Username/Password credential
bee cred create \
  --username <username> \
  [--id <cred_id>] \
  [--password <password>] \
  [--description <text>] \
  [--scope GLOBAL|SYSTEM] \
  [--store system|user]

# Update credential
bee cred update <cred_id> \
  [--username-cred <new_username>] \
  [--password <new_password>] \
  [--description <new_description>] \
  [--store system|user]

# Delete credential
bee cred delete <cred_id> [--yes] [--store system|user]
```

### Nodes (`bee node`)

```bash
# List tracked nodes (or all nodes)
bee node list [--all]

# Show node details
bee node get <name>

# Create node (SSH or JNLP/Inbound)
bee node create \
  --name <node_name> \
  --remote-dir </path/to/workdir> \
  [--executors 1] \
  [--labels "<space-separated labels>"] \
  [--description <text>] \
  [--host <ssh_host>] \
  [--port 22] \
  [--cred-id <credential_id>] \
  [--java-path </path/to/java>]

# Update node config
bee node update <name> \
  [--description <text>] \
  [--remote-dir </path/to/workdir>] \
  [--executors <n>] \
  [--labels "<space-separated labels>"]

# Copy node config
bee node copy <source_name> <new_name>

# Toggle connectivity
bee node offline <name> [--reason <message>]
bee node online <name>

# Delete node
bee node delete <name> [--yes]
```

## Tracked Resources

By default `job list`, `node list`, and `cred list` show only resources created through `bee` (recorded in a local `user_resources` table). Pass `--all` to show everything on the server. Resources tracked locally but missing on the server are shown as `[DELETED_ON_SERVER]`.

## Cache

SQLite TTL cache is used for GET calls (controllers, jobs, nodes, credentials — all 10 s TTL). Writes automatically invalidate related cache entries.

## TUI

`bee --ui` launches an interactive terminal UI built with [Ink](https://github.com/vadimdemedes/ink) (React for the terminal). It shares the same service layer as the CLI, so it talks to the same session, cache, and tracked-resource state. Requires an interactive terminal (a TTY).

Each plugin contributes its own tab via an optional `screen()` in its `Plugin` object; tabs are collected and ordered at startup. The Jobs tab is available today; Controllers, Credentials, Nodes, and Settings tabs are planned.

Global keys:

| Key | Action |
|---|---|
| `1`–`9` | Jump to tab N |
| `Tab` / `Shift+Tab` | Next / previous tab |
| `←` / `→` | Previous / next tab |
| `?` | Toggle help |
| `q` | Quit |

Jobs tab:

| Key | Action |
|---|---|
| `j` / `k` | Move cursor down / up (also `↓`/`↑`) |
| `g` / `G` | Jump to first / last row |
| `Ctrl+f` / `Ctrl+b` | Page down / up |
| `a` | Toggle Mine / All (tracked vs. all jobs) |
| `Enter` / `l` | Open build log viewer |
| `r` | Run the selected job |
| `s` | Stop the selected job |
| `n` | Create a new job |
| `d` | Delete the selected job |
| `R` | Refresh the list |

In the log viewer, `q` / `b` / `Esc` returns to the list.

Set `BEE_ASCII=1` to force ASCII symbols and borders instead of Unicode (useful on terminals with limited glyph support).

## Security

Session tokens are encrypted with **AES-256-GCM**. The key is derived via `scrypt(secret || uid)` where `secret` is a random 32-byte value stored in `.bee_secret` (next to the DB, `chmod 600`). A leaked DB file alone is not enough to recover the token — the secret file must also be accessible, and it is readable only by its owner. Mixing the uid into the key means copying the secret file to another account still derives a different key.

- API requests use `Authorization: Basic <base64(user:token)>`.
- CSRF crumb is auto-fetched and attached for all write operations.
- `bee auth logout` clears the saved session token.

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
│   ├── main.ts           # Entry point, CLI root, plugin registry bootstrap
│   ├── core/
│   │   ├── api/          # HTTP client, CSRF crumb, retry, exceptions
│   │   ├── db/           # SQLite connection, schema, repositories
│   │   └── session/      # AES-256-GCM session crypto
│   └── plugins/
│       ├── auth/         # bee auth
│       ├── controller/   # bee controller
│       ├── job/          # bee job
│       ├── credential/   # bee cred
│       └── node/         # bee node
└── data/                 # runtime SQLite DB (created on first run)
```

## License

MIT
