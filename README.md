# CloudBees CLI + TUI (`cb`)

A lightweight Python tool to manage CloudBees from your terminal — CLI for scripting, TUI for interactive use.

## Requirements

- Python **3.8+** (tested: 3.8, 3.10, 3.11, 3.12)
- Dependencies: `click`, `httpx`, `cryptography`

## Install

```bash
git clone https://github.com/hyhy2001/cloudbees.git
cd cloudbees
make install
```

> Dependencies are installed into `./lib/` — no virtualenv, no sudo, no system changes.

## Run

```bash
make run ARGS="login"
make run ARGS="job list"
make ui                     # TUI mode
```

Or call directly:

```bash
python3 run.py --help
python3 run.py login
```

Create an alias for convenience:

```bash
alias cb="python3 /path/to/cloudbees/run.py"   # bash/zsh
alias cb 'python3 /path/to/cloudbees/run.py'   # csh/tcsh
```

Then use `cb` as normal: `cb job list`, `cb --ui`, etc.

### Troubleshooting

| Error | Fix |
|-------|-----|
| `Permission denied` on `./data/cb.db` | `export CB_DB_PATH=/tmp/cb.db` |
| `cb: command not found` | Use `python3 run.py` or set the alias above |
| `source activate` → "badly placed" | Server uses csh/tcsh — use the alias approach instead |
| `pip` broken (OpenSSL...) | Try `pip3 install --target=./lib ...` or `python3 -m pip install --target=./lib ...` |

---

## Quick Start

```bash
python3 run.py login                          # Login (saves encrypted token)
python3 run.py controller list               # List controllers
python3 run.py controller select <name>      # Set active controller
python3 run.py job list                      # List all jobs
python3 run.py --ui                          # Launch TUI
```

---

## CLI Reference

### Auth

```bash
cb login                    # Interactive login
cb auth profiles            # List saved profiles
cb auth logout              # Remove stored token
```

### Controller

```bash
cb controller list               # List all controllers
cb controller info <name>        # Controller details
cb controller select <name>      # Set active controller
cb controller current            # Show active controller
```

### Jobs

```bash
cb job list [-o json|table]                      # List jobs (FS/PL/FD type column)
cb job get <name>                                # Job details + last build
cb job create freestyle <name> [--shell "cmd"]   # Create Freestyle project
cb job create pipeline <name> [--script-file F]  # Create Pipeline job
cb job create folder <name>                      # Create Folder
cb job delete <name> [--yes]                     # Delete job/folder
cb job run <name> [--wait] [--timeout 120]       # Trigger build
cb job stop <name> <build#>                      # Stop a running build
cb job log <name> [build#] [--follow]            # Print / stream console log
cb job status <name> [--count 10]               # Recent build history
```

**Job type symbols:**

| Symbol | Type |
|--------|------|
| `FS` | Freestyle project |
| `PL` | Pipeline |
| `FD` | Folder |

### Credentials

```bash
cb cred list [-o json|table]                          # List credentials
cb cred get <id>                                      # Show details (secret masked)
cb cred create --id <id> --username <u> [--password]  # Create Username+Password
cb cred delete <id> [--yes]                           # Delete credential
```

> Password is always prompted with hidden input if not provided via flag.

### Nodes

```bash
cb node list [-o json|table]                           # List nodes + online/offline
cb node get <name>                                     # Node details
cb node create --name <n> --remote-dir /home/jenkins   # Create Permanent Agent (JNLP)
cb node copy <source> <new-name>                       # Clone a node's config
cb node delete <name> [--yes]                          # Delete node
cb node offline <name> [--reason "msg"]                # Mark offline
cb node online <name>                                  # Bring back online
```

### Users

```bash
cb users list [-o json|table]    # List users
cb users get <user-id>           # User details
```

### System

```bash
cb system health                      # Server health check
cb system version                     # CloudBees version
cb system cache-clear                 # Clear API cache
cb system cache-clear --expired-only  # Purge expired entries only
```

---

## TUI Mode

```bash
python3 run.py --ui
```

**Sidebar navigation:**

```
[1] Dashboard  [2] Controllers  [3] Jobs  [4] Credentials  [5] Nodes  [6] Users  [7] System
```

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `q` | Quit |
| `Tab` | Cycle screens |
| `1`–`7` | Jump to screen |
| `↑` / `↓` | Navigate list |
| `r` | Run selected job |
| `l` | Console log |
| `c` | Create new item |
| `d` | Delete selected |
| `o` | Toggle node offline/online |
| `Enter` | Select / detail |
| `F5` | Force refresh |
| `C` | Clear cache |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CB_PROFILE` | Active profile name | `default` |
| `CB_CONTROLLER` | Active controller (overrides saved) | — |
| `CB_PASSWORD` | Master password (skip interactive prompt) | — |
| `CB_DB_PATH` | Custom database path | `./data/cb.db` |

---

## Security

- Tokens encrypted with **Fernet (AES-128-CBC)** + **PBKDF2HMAC-SHA256** (390k iterations)
- Derived key lives only in RAM — never written to disk
- `cb cred create` always uses hidden input — password never in shell history
- `cb cred get` always shows `[HIDDEN]` for secret fields

---

## Caching

All `GET` responses are cached in SQLite:

| Resource | TTL |
|----------|-----|
| `controllers.list` | 120 s |
| `jobs.list` | 60 s |
| `credentials.list` | 60 s |
| `nodes.list` | 30 s |
| `users.list` | 300 s |
| `system.health` | 15 s |

> Bypass: `F5` in TUI or `cb system cache-clear`

---

## Project Structure

```
cloudbees/
├── run.py              # Launcher (auto-adds ./lib to sys.path)
├── lib/                # Local dependencies (gitignored)
├── data/               # SQLite DB — tokens, cache, settings (gitignored)
└── cb/
    ├── api/            # HTTP client, CSRF crumb, XML builder
    ├── cache/          # SQLite TTL cache
    ├── cli/commands/   # auth, controller, jobs, credentials, nodes, users, system
    ├── crypto/         # Fernet + PBKDF2HMAC
    ├── db/             # SQLite schema, repositories
    ├── dtos/           # Dataclass DTOs
    ├── services/       # Business logic
    └── tui/            # curses TUI (256-color, ASCII borders)
```

---

## Tests

```bash
pip install pytest
pytest tests/unit/ -v   # 28 tests
```

---

## Version History

| Version | Changes |
|---------|---------|
| `0.2.0` | Controller, Credential, Node management; Job create (Freestyle/Pipeline/Folder); `run.py` local launcher; local `./lib` install |
| `0.1.0` | Initial release — auth, job list/run/stop, TUI, encrypted storage, cache |