# CloudBees CLI + TUI (`bee`) 🐝

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

> `bee` is installed to `~/.local/bin/`. If not found, run:
> `export PATH="$HOME/.local/bin:$PATH"` (add to `~/.bashrc` to make permanent)

---

## Quick Start

```bash
bee login                          # Login
bee controller list                # List controllers
bee controller select <name>       # Set active controller
bee job list                      # List all jobs
bee --ui                          # Launch TUI
```

---

## CLI Reference

### Auth

```bash
bee login                    # Interactive login
bee auth profiles            # List saved profiles
bee auth logout              # Remove stored token
```

### Controller

```bash
bee controller list               # List all controllers
bee controller info <name>        # Controller details
bee controller select <name>      # Set active controller
bee controller current            # Show active controller
```

### Jobs

```bash
bee job list [-o json|table]                      # List jobs (FS/PL/FD type column)
bee job get <name>                                # Job details + last build
bee job create freestyle <name> [--shell "cmd"]   # Create Freestyle project
bee job create pipeline <name> [--script-file F]  # Create Pipeline job
bee job create folder <name>                      # Create Folder
bee job delete <name> [--yes]                     # Delete job/folder
bee job run <name> [--wait] [--timeout 120]       # Trigger build
bee job stop <name> <build#>                      # Stop a running build
bee job log <name> [build#] [--follow]            # Print / stream console log
bee job status <name> [--count 10]               # Recent build history
```

**Job type symbols:**

| Symbol | Type |
|--------|------|
| `FS` | Freestyle project |
| `PL` | Pipeline |
| `FD` | Folder |

### Credentials

```bash
bee cred list [-o json|table]                          # List credentials
bee cred get <id>                                      # Show details (secret masked)
bee cred create --id <id> --username <u> [--password]  # Create Username+Password
bee cred delete <id> [--yes]                           # Delete credential
```

> Password is always prompted with hidden input if not provided via flag.

### Nodes

```bash
bee node list [-o json|table]                           # List nodes + online/offline
bee node get <name>                                     # Node details
bee node create --name <n> --remote-dir /home/jenkins   # Create Permanent Agent (JNLP)
bee node copy <source> <new-name>                       # Clone a node's config
bee node delete <name> [--yes]                          # Delete node
bee node offline <name> [--reason "msg"]                # Mark offline
bee node online <name>                                  # Bring back online
```

### Users

```bash
bee users list [-o json|table]    # List users
bee users get <user-id>           # User details
```

### System

```bash
bee system health                      # Server health check
bee system version                     # CloudBees version
bee system cache-clear                 # Clear API cache
bee system cache-clear --expired-only  # Purge expired entries only
```

---

## TUI Mode

```bash
bee --ui
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
- `bee cred create` always uses hidden input — password never in shell history
- `bee cred get` always shows `[HIDDEN]` for secret fields

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

> Bypass: `F5` in TUI or `bee system cache-clear`

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