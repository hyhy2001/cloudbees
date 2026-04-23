# bee - CloudBees CLI + TUI

`bee` is a Python terminal tool for operating CloudBees CI/Jenkins controllers.

- CLI mode for scripting and automation
- TUI mode (Textual) for interactive operations
- Local SQLite for session, cache, and tracked resources

## What It Can Do

- Authentication and profile management
- Controller discovery and active-controller selection
- Job lifecycle: list/get/create/update/delete/run/stop/log/status/copy
- Credential lifecycle: list/get/create/update/delete (system/user stores)
- Node lifecycle: list/get/create/update/delete/offline/online/copy
- TUI tabs for Controller, Credentials, Nodes, Jobs, and Settings

## Requirements

- Python `>=3.8`
- `make`
- Network access to your CloudBees/Jenkins endpoint

## Install

### Recommended (project-local venv)

```bash
git clone https://github.com/hyhy2001/cloudbees.git
cd cloudbees
make init
```

This creates `.venv/`, installs dependencies, and registers the `bee` console script in that venv.

### Activate shell (optional but convenient)

```bash
source .venv/bin/activate
bee --help
```

If you do not activate the venv, you can still run:

```bash
make run ARGS='--help'
make ui
```

## Quick Start

```bash
bee auth login
bee controller list
bee controller select <controller-name>
bee job list
bee --ui
```

## CLI Reference

Global options:

```bash
bee --version
bee --ui
bee --debug
```

### Auth (`bee auth`)

```bash
# Login and save session/profile
bee auth login \
  --url <cloudbees_url> \
  --username <username> \
  --token <api_token> \
  [--profile default]

# Logout profile session token
bee auth logout [--profile <profile_name>]

# Delete a saved profile
bee auth delete --profile <profile_name>

# List all profiles
bee auth profiles
```

### Controller (`bee controller`)

```bash
# List controllers
bee controller list

# Show details and capabilities
bee controller info <name>

# Set active controller
bee controller select <name>

# Show active controller
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

# Stop specific build
bee job stop <name> <build_number>

# Show log (or stream)
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

- `--email-keyword` is repeatable and matches **ANY** keyword in console output.
- `--email-regex` matches console output with case-insensitive regex.
- If both keyword and regex are provided, send condition is `keyword_match OR regex_match`.
- Mail is sent only when: `(email-cond trigger) AND (content filter match)`.
- If filter is provided without a valid recipient email, command fails fast.

### Credentials (`bee cred`)

```bash
# List credentials
bee cred list \
  [-o|--output table|json] \
  [--all] \
  [--store system|user]

# Read credential metadata
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
  [--username-cred <new_username_or_id>] \
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

# Node details
bee node get <name>

# Create node (SSH or inbound/JNLP style)
bee node create \
  --name <node_name> \
  --remote-dir </path/to/workdir> \
  [--executors 1] \
  [--labels "<space separated labels>"] \
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
  [--labels "<space separated labels>"]

# Copy node config
bee node copy <source_name> <new_name>

# Toggle connectivity
bee node offline <name> [--reason <message>]
bee node online <name>

# Delete node
bee node delete <name> [--yes]
```

## TUI Mode

Launch:

```bash
bee --ui
```

Global keys:

- `q`: quit
- `l`: login
- `x`: logout (clear session)
- `1`-`5`: jump tabs
- `Tab` / `Shift+Tab`: next/previous tab
- `F5`: refresh active tab
- `F2`: toggle dark/light
- `?`: help overlay

Resource tabs:

- Jobs: `r` run, `s` stop, `l` log, `n` new, `d` delete, `a` mine/all
- Nodes: `o` offline/online, `n` new, `d` delete, `a` mine/all
- Credentials: `c` create, `d` delete, `S` store toggle, `a` mine/all
- Settings: `c` clear cache

Terminal rendering mode:

- Unicode is enabled by default on UTF-8 terminals.
- Set `BEE_ASCII=1` to force ASCII-safe symbols/borders.

## Environment Variables

- `CB_DB_PATH`: override SQLite DB path
  - default: `./data/cb.db` (relative to current working directory)
- `BEE_ASCII`: force ASCII UI rendering (`1/true/yes`)

## Data, Session, and Security Notes

- Data is stored in SQLite (`profiles`, `settings`, `cache`, tracked resources, etc.).
- Session token is stored encrypted with a machine-derived key (`settings` table).
- `bee auth logout` clears the saved session.
- API requests use Basic auth token format (`Authorization: Basic ...`).
- CSRF crumb is auto-fetched and attached for write operations.

## Cache Policy

SQLite TTL cache is used for GET calls.

- Controllers: 60s
- Credentials: 60s
- Jobs: 30s
- Nodes: 30s
- Default: 30s

Writes invalidate related cache prefixes automatically.

## Project Structure

```text
cloudbees/
├── Makefile
├── README.md
├── run.py
├── cb/
│   ├── api/                # HTTP client, crumb, XML builders, exceptions
│   ├── cache/              # SQLite TTL cache manager/policy
│   ├── cli/commands/       # auth, controller, job, cred, node
│   ├── db/                 # connection, schema, repositories
│   ├── dtos/               # transport/data DTOs
│   ├── services/           # domain logic for each resource
│   └── tui/                # Textual app, screens, widgets
└── data/                   # runtime SQLite DB (created on demand)
```

## Development Notes

- Install dev extras: `pip install -e .[dev]`
- Run tests: `pytest`
- Main entry point: `cb/main.py` (`bee` console script)

## License

MIT
