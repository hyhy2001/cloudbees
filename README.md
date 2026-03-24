# CloudBees CLI + TUI (`cb`)

A lightweight Python tool to manage CloudBees from your terminal.
Two modes: **CLI** (scriptable/automatable) and **TUI** (interactive ncurses interface).

## Requirements

- Python **3.8+** (tested: 3.8, 3.10, 3.11, 3.12)
- External deps: `click`, `httpx`, `cryptography` (everything else is stdlib)

## Install

### Bước 1 — Clone repository

```bash
git clone https://github.com/hyhy2001/cloudbees.git
cd cloudbees
```

### Bước 2 — Cài đặt dependencies

> **Khuyến nghị:** Dùng virtual environment để tránh xung đột với package hệ thống.

**Cách A — Dùng virtualenv (khuyến nghị, tránh lỗi permission)**

```bash
# Tạo virtual environment trong thư mục hiện tại
python3 -m venv .venv

# Kích hoạt
source .venv/bin/activate   # Linux / macOS

# Cài package
pip install -e .

# Kiểm tra
cb --version
```

> Mỗi lần mở terminal mới, chạy `source .venv/bin/activate` từ thư mục `cloudbees/`.

**Cách B — Cài cho user hiện tại (không cần sudo)**

```bash
pip install --user -e .

# Đảm bảo ~/.local/bin nằm trong PATH
export PATH="$HOME/.local/bin:$PATH"
# Thêm dòng trên vào ~/.bashrc hoặc ~/.zshrc để tự động load

cb --version
```

**Cách C — Chạy trực tiếp không cần cài (mọi lúc)**

```bash
# Không cần cài gì thêm, chạy luôn bằng python3
python3 -m cb.main --help
python3 -m cb.main job list
python3 -m cb.main --ui
```

> Đây là cách dùng an toàn nhất trên server công ty khi không có quyền cài package.

### Bước 3 — Kiểm tra cài đặt

```bash
cb --version
# cb, version 0.2.0

cb --help
# Hiển thị danh sách commands đầy đủ
```

> **Ghi chú:** Data (DB, token) được lưu tại `./data/cb.db` trong thư mục hiện tại.
> Để đổi sang nơi khác: `export CB_DB_PATH=/your/path/cb.db`

---

### Troubleshooting cài đặt

**Lỗi: `Permission denied` khi chạy `pip install -e .`**

```bash
# Dùng --user flag thay vì cài system-wide
pip install --user -e .
export PATH="$HOME/.local/bin:$PATH"
```

**Lỗi: `Permission denied` khi tạo `./data/cb.db`**

```bash
# Kiểm tra quyền thư mục hiện tại
ls -la .

# Hoặc chỉ định path khác
export CB_DB_PATH="/tmp/cb.db"
cb --version   # thử lại
```

**Lỗi: `cb: command not found` sau khi cài**

```bash
# Kiểm tra PATH
which cb || echo "cb not in PATH"

# Dùng python3 -m cb.main thay thế
python3 -m cb.main --help

# Hoặc thêm vào PATH (nếu dùng --user)
export PATH="$HOME/.local/bin:$PATH"
```

**Lỗi: pip hệ thống bị broken (OpenSSL conflict,...)**

```bash
# Dùng virtualenv trong thư mục hiện tại
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/cb --version

# Hoặc tạo alias tiện dùng
alias cb="$(pwd)/.venv/bin/cb"
```

---

### Update

```bash
cd cloudbees
git pull
pip install -e .    # (hoặc cách đã dùng khi cài lần đầu)
cb --version
```

---

## Quick Start

```bash
# Login (interactive prompt)
cb login

# Select a controller (CloudBees CI multi-controller setup)
cb controller list
cb controller select my-controller

# List jobs
cb job list

# Launch TUI
cb --ui
```

---

## CLI Reference

### Authentication

```bash
cb login                          # Interactive login (saves encrypted token)
cb auth profiles                  # List saved profiles
cb auth logout                    # Remove stored token
```

### Controller

```bash
cb controller list                # List all controllers
cb controller info <name>         # Controller details
cb controller select <name>       # Set active controller
cb controller current             # Show currently active controller
```

### Jobs

```bash
cb job list [-o json|table]                        # List all jobs (with type)
cb job get <name>                                  # Job details + last build
cb job create freestyle <name> [--shell "cmd"]     # Create Freestyle project
cb job create pipeline <name> [--script-file F]    # Create Pipeline job
cb job create folder <name>                        # Create Folder
cb job delete <name> [--yes]                       # Delete job/folder
cb job run <name> [--wait] [--timeout 120]         # Trigger build (optionally wait)
cb job stop <name> <build#>                        # Stop a running build
cb job log <name> [build#] [--follow]              # Print / stream console log
cb job status <name> [--count 10]                  # Recent build history
```

**Job types in list output:**

| Symbol | Type |
|--------|------|
| `FS` | Freestyle project |
| `PL` | Pipeline (Jenkinsfile) |
| `FD` | Folder |

### Credentials

```bash
cb cred list [-o json|table]                         # List all credentials
cb cred get <id>                                     # Show details (secret masked)
cb cred create --id <id> --username <u> [--password] # Create Username+Password cred
cb cred delete <id> [--yes]                          # Delete credential
```

> **Security:** `--password` is always prompted with hidden input if not provided via flag.

### Nodes (Agent Management)

```bash
cb node list [-o json|table]                        # List nodes with online/offline status
cb node get <name>                                  # Node details (launcher, remote dir)
cb node create --name <n> --remote-dir /home/jenkins [--executors 1] [--labels "linux"]
                                                    # Create Permanent Agent (JNLP)
cb node copy <source> <new-name>                    # Clone an existing node's config
cb node delete <name> [--yes]                       # Delete node
cb node offline <name> [--reason "msg"]             # Mark node offline
cb node online <name>                               # Bring node back online
```

### Users

```bash
cb users list [-o json|table]     # List users
cb users get <user-id>            # User details
```

### System

```bash
cb system health                  # Server health check
cb system version                 # CloudBees server version
cb system cache-clear             # Clear API response cache
cb system cache-clear --expired-only  # Only purge expired entries
```

---

## TUI Mode

```bash
cb --ui
```

**Sidebar navigation (7 screens):**

```
[1] Dashboard     [2] Controllers   [3] Jobs
[4] Credentials   [5] Nodes         [6] Users   [7] System
```

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `q` | Quit |
| `Tab` | Cycle screens |
| `1`–`7` | Jump to screen |
| `↑` / `↓` or `k` / `j` | Navigate list |
| `r` | Run selected job |
| `l` | Log of selected job |
| `c` | Create new item |
| `d` | Delete selected item |
| `o` | Toggle node offline/online |
| `Enter` | Select / detail |
| `F5` | Force refresh (bypass cache) |
| `C` | Clear cache |
| `l` (on Dashboard) | Login |
| `?` | Help |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CB_PROFILE` | Active profile name | `default` |
| `CB_CONTROLLER` | Active controller (overrides saved setting) | — |
| `CB_PASSWORD` | Master password (avoid interactive prompt in scripts) | — |
| `CB_DB_PATH` | Custom database path | `~/.cb/cb.db` |

---

## Security

- API tokens and credentials are **never stored in plain text**
- Tokens are encrypted with **Fernet (AES-128-CBC)** using a key derived via **PBKDF2HMAC-SHA256** (390,000 iterations) from your master password
- The derived key exists **only in RAM** during a session
- `cb cred create` always prompts with hidden input — password never appears in shell history
- `cb cred get` always shows `[HIDDEN]` for secret fields

---

## API Response Caching

All `GET` requests are cached in SQLite with configurable TTLs:

| Resource | TTL |
|----------|-----|
| `jobs.list` | 60 s |
| `jobs.detail` | 30 s |
| `controllers.list` | 120 s |
| `credentials.list` | 60 s |
| `credentials.detail` | 120 s |
| `nodes.list` | 30 s |
| `nodes.detail` | 15 s |
| `users.list` | 300 s |
| `system.health` | 15 s |

> **Bypass cache:** `F5` in TUI or `cb system cache-clear`

---

## Architecture

```
cb/
├── api/          # HTTP client (httpx), CSRF crumb, XML builder
├── cache/        # SQLite TTL cache manager
├── cli/          # click command groups
│   └── commands/ # auth, controller, jobs, credentials, nodes, users, system
├── crypto/       # Fernet + PBKDF2HMAC encryption
├── db/           # SQLite connection, schema, repositories
│   └── repositories/  # profile_repo, settings_repo
├── dtos/         # Dataclass DTOs (no external deps)
│   └── controller, credential, node, job, user, auth
├── services/     # Business logic (UI-agnostic)
│   └── auth, controller, job, credential, node, user, system
└── tui/          # curses TUI (256-color + 8-color fallback)
    ├── app.py    # Main event loop
    ├── colors.py # Color palette
    ├── keys.py   # Keyboard constants
    ├── screens/  # Dashboard, Controllers, Jobs, Credentials, Nodes, Users, System
    └── widgets/  # Header, sidebar, ASCII table, input box, form
```

**Design decisions:**
- **Zero extra dependencies** for TUI: uses Python built-in `curses`
- **ASCII-only borders** (`+`, `-`, `|`) for maximum terminal compatibility
- **SQLite3** for profiles, encrypted tokens, API cache, and settings — no YAML, no keyring
- **XML builder** uses stdlib `xml.etree.ElementTree` — no `lxml` needed

---

## Running Tests

```bash
pytest tests/unit/ -v
# 28 tests — cache, crypto, DTOs (Controller, Credential, Node, Build, Job types)
```

---

## Version History

| Version | Changes |
|---------|---------|
| `0.2.0` | Controller selection, Credential create/list/delete, Node create/copy/manage, Job create (Freestyle/Pipeline/Folder), build log + follow, build history |
| `0.1.0` | Initial release — auth, job list/run/stop, TUI, encrypted storage, API cache |