# bee 🐝 — CloudBees CLI + TUI

A lightweight Python tool to manage CloudBees CI from your terminal.  
**CLI** for scripting · **TUI** for interactive use · No `sudo` · No virtualenv required.

## Requirements

- Python **3.9+**
- Dependencies auto-installed by `make install`: `click`, `httpx`, `cryptography`, `textual`

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
# Default: system store (shared, usable by Jobs and Nodes)
bee cred list [-o json|table]
bee cred get <id>
bee cred create --id <id> --username <u> [--password]
bee cred delete <id> [--yes]

# User store (personal, scoped to your account)
bee cred list --store user
bee cred create --store user --id <id> --username <u>
bee cred delete --store user <id>
```

| Store | Path | Accessible by |
|-------|------|--------------|
| `system` (default) | `/credentials/store/system/domain/_` | Jobs, Nodes, all users |
| `user` | `/user/<username>/credentials/store/user/domain/_` | Logged-in user only |

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

Built with **[Textual](https://textual.textualize.io/)** — async-first, non-blocking UI. All API calls run in background threads so the interface stays responsive at all times.

> **ASCII-first design** — borders use `|` `+` `-` characters, works on any Linux terminal including `LANG=C` / POSIX.  
> Set `BEE_UNICODE=1` to opt in to Unicode symbols on supported terminals.

**Tabs:**
```
[1] Controller   [2] Credentials   [3] Nodes   [4] Jobs   [5] Settings
```

**Keys:**

| Key | Action |
|-----|--------|
| `q` | Quit (session saved) |
| `1`–`5` | Jump to screen |
| `↑` / `↓` | Navigate list |
| `Enter` | Open detail screen |
| `L` | Login |
| `X` | Logout (clears session) |
| `r` | Run selected job (Jobs) |
| `s` | Stop last build (Jobs) · Toggle store: system↔user (Credentials) |
| `l` | View live streaming build log (Jobs) |
| `n` | Create new item (Jobs / Nodes) |
| `d` | Delete selected item |
| `o` | Toggle node offline/online (Nodes) |
| `c` | Create credential (Credentials) · Clear cache (Settings) |
| `a` | Toggle Mine / All scope (all resource tabs) |
| `?` | Show keyboard help overlay |
| `F5` | Force refresh (bypass cache, re-fetch from API) |
| `F2` | Toggle dark/light mode |
| `Esc` | Close modal / go back |

> **Session:** Login once → session saved encrypted in SQLite. Reopen TUI/CLI anytime without re-entering credentials. `X` to logout.
> 
> **Resource Tracking:** Resources (Jobs, Nodes, Credentials) created via `bee` are persistently tracked. The TUI and CLI default to filtering by **MINE**, showing only your items. Press `a` (or pass `--all`) to toggle to **ALL** items. Live streaming logs use Jenkins progressive API to tail logs without hanging the UI.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CB_PROFILE` | Active profile name | `default` |
| `CB_DB_PATH` | Custom database path | `./data/cb.db` |
| `CB_PASSWORD` | Password for non-interactive scripting | — |

---

## Security

- Session token encrypted with XOR cipher using a machine-derived key (SHA-256 of a per-machine random secret stored in SQLite)
- API tokens (Basic Auth) stored as `username:password` Base64, encrypted with the machine key at rest
- Secrets always use hidden input — never exposed in shell history
- `X` (Logout) deletes session; `q` (Quit) preserves it for next launch

---

## Caching

All `GET` responses cached in SQLite with short TTLs for fast refresh:

| Resource | TTL |
|----------|-----|
| `controllers.list/detail` | 60 s |
| `controllers.capabilities` | 60 s |
| `jobs.list/detail` | 30 s |
| `credentials.list/detail` | 60 s |
| `nodes.list/detail` | 30 s |
| Default (other resources) | 30 s |

`F5` or `bee system cache-clear` bypasses the cache and forces a live API call.

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
    ├── cache/          # SQLite TTL cache (manager + policy)
    ├── cli/commands/   # auth, controller, jobs, credentials, nodes, users, system
    ├── crypto/         # Encryption utilities (reserved)
    ├── db/             # SQLite schema, connection, repositories
    ├── dtos/           # Dataclass DTOs (Job, Node, Credential, Auth…)
    ├── services/       # Business logic (auth, session, job, node, credential…)
    └── tui/            # Textual TUI
         ├── app.py          # BeeApp — main Textual App class
         ├── bee.tcss        # Textual CSS (GitHub dark theme)
         ├── screens/        # One Screen class per tab
         └── widgets/        # Shared modals (Login, Confirm, Info, CreateCred)
```

---

## Version History

| Version | Changes |
|---------|---------|
| `0.4.0` | **Live Log Streaming** (Progressive API polling), Persistent Resource Tracking (MINE vs ALL), Smart CLI Status Formatting (`NEW (Run)`, `OK`, `FAIL`), offline-capable routing |
| `0.3.0` | **Textual TUI** (async workers, non-blocking UI), dual credential store (system/user), shorter TTLs (30–60s), Python 3.9+, `--store` CLI option |
| `0.2.0` | Controller, Credential, Node management; Job create; local `./lib` install |
| `0.1.0` | Initial release — auth, job list/run/stop, TUI, encrypted storage, cache |