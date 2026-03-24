# bee 🐝 — CloudBees CLI + TUI

A lightweight Python tool to manage CloudBees from your terminal.  
**CLI** for scripting · **TUI** for interactive use · No `sudo` · No virtualenv required.

## Requirements

- Python **3.8+**
- Dependencies auto-installed by `make install`: `click`, `httpx`, `cryptography`

## Install

```bash
git clone https://github.com/hyhy2001/cloudbees.git
cd cloudbees
make install
```

> `bee` is installed to `~/.local/bin/`. If not found, add to PATH:
> - **bash/zsh:** `export PATH="$HOME/.local/bin:$PATH"`
> - **csh/tcsh:** `setenv PATH ~/.local/bin:$PATH`

---

## Quick Start

```bash
bee --ui                           # Launch TUI (recommended)
bee login                          # CLI login
bee job list                       # List all jobs
bee controller list                # List controllers
```

---

## CLI Reference

### Auth

```bash
bee login                    # Interactive login (saves session)
bee auth profiles            # List saved profiles
bee auth logout              # Remove stored token + session
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
bee job list [-o json|table]                      # List jobs
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

| Symbol | Type |
|--------|------|
| `FS` | Freestyle project |
| `PL` | Pipeline |
| `FD` | Folder |

### Credentials

```bash
bee cred list [-o json|table]
bee cred get <id>
bee cred create --id <id> --username <u> [--password]
bee cred delete <id> [--yes]
```

### Nodes

```bash
bee node list [-o json|table]
bee node get <name>
bee node create --name <n> --remote-dir /home/jenkins
bee node offline <name> [--reason "msg"]
bee node online <name>
bee node delete <name> [--yes]
```

### Users

```bash
bee users list [-o json|table]
bee users get <user-id>
```

### System

```bash
bee system health
bee system version
bee system cache-clear
```

---

## TUI Mode

```bash
bee --ui
```

**Sidebar:**
```
[1] Dashboard  [2] Controller  [3] Credentials  [4] Nodes  [5] Jobs  [6] Users  [7] System
```

**Keys:**

| Key | Action |
|-----|--------|
| `q` | Quit (session saved) |
| `Tab` / `←` `→` | Cycle screens |
| `1`–`7` | Jump to screen |
| `↑` / `↓` or `j`/`k` | Navigate list |
| `Enter` | Select / detail |
| `L` | Login |
| `X` | Logout (clears session) |
| `r` | Run selected job |
| `o` | Toggle node offline/online |
| `F5` | Force refresh |
| `C` | Clear cache |

> **Session:** Login once → session saved encrypted in `.db`. Reopen TUI/CLI anytime without re-entering credentials. `X` to logout and clear session.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CB_PROFILE` | Active profile name | `default` |
| `CB_CONTROLLER` | Active controller override | — |
| `CB_PASSWORD` | Password for non-interactive scripting | — |
| `CB_DB_PATH` | Custom database path | `./data/cb.db` |

---

## Security

- Session token encrypted with machine-derived key (stored in SQLite `settings`)
- API tokens encrypted with **Fernet (AES-128-CBC)** + **PBKDF2HMAC-SHA256** (390k iterations)
- Secrets always use hidden input — never in shell history
- `X` (Logout) deletes session; `q` (Quit) preserves it

---

## Caching

All `GET` responses cached in SQLite:

| Resource | TTL |
|----------|-----|
| `controllers.list` | 120 s |
| `jobs.list` | 60 s |
| `credentials.list` | 60 s |
| `nodes.list` | 30 s |
| `users.list` | 300 s |
| `system.health` | 15 s |

---

## Project Structure

```
cloudbees/
├── Makefile            # make install / uninstall / run / ui
├── run.py              # Launcher (adds ./lib to sys.path)
├── lib/                # Local dependencies (gitignored)
├── data/               # SQLite DB — tokens, cache, settings (gitignored)
└── cb/
    ├── api/            # HTTP client, CSRF crumb, XML builder
    ├── cache/          # SQLite TTL cache
    ├── cli/commands/   # auth, controller, jobs, credentials, nodes, users, system
    ├── crypto/         # Fernet + PBKDF2HMAC
    ├── db/             # SQLite schema, repositories
    ├── dtos/           # Dataclass DTOs
    ├── services/       # Business logic (auth, session, job, node…)
    └── tui/            # curses TUI (256-color, ASCII borders)
```

---

## Version History

| Version | Changes |
|---------|---------|
| `0.3.0` | Persistent session (auto-login), Logout key, 7-screen TUI nav, arrow keys, login form fix, FK bug fixed |
| `0.2.0` | Controller, Credential, Node management; Job create; local `./lib` install |
| `0.1.0` | Initial release — auth, job list/run/stop, TUI, encrypted storage, cache |