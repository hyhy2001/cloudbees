# CloudBees CLI + TUI Framework

> **Project Type:** BACKEND — Python CLI Tool (Độc lập hoàn toàn)
> **Updated:** 2026-03-24
> **Agent:** `backend-specialist` + `project-planner`

---

## 🎯 Goal

Xây dựng một Python CLI tool hai chế độ cho CloudBees:
- **CLI mode** → automation, scripting, CI/CD pipelines
- **TUI mode** → giao diện `curses` (built-in) trực quan, keyboard-driven

Dữ liệu (API token, server URL, credentials) được lưu trong **SQLite3** và **mã hoá bằng `cryptography`**.

---

## ✅ Success Criteria

- [ ] CLI: `cb jobs list`, `cb pipeline run <id>` ... hoạt động
- [ ] TUI: `cb --ui` mở giao diện curses với navigation keyboard
- [ ] Login: Nhập credentials → mã hoá → lưu SQLite3 → auto-load ở lần sau
- [ ] Mỗi service module độc lập, testable riêng
- [ ] DTOs (dataclasses) serialize/deserialize JSON từ CloudBees REST API
- [ ] Không lưu plain-text password hay token ở bất kỳ đâu

---

## 🏗️ Tech Stack

| Layer | Công nghệ | Lý do |
|-------|-----------|-------|
| Language | Python 3.11+ | Built-in curses, sqlite3, dataclasses, json |
| CLI parsing | `click` | Composable commands, DX tốt |
| HTTP Client | `httpx` | Modern, timeout/retry support |
| TUI | `curses` (stdlib) | Built-in, không cần deps ngoài |
| DTOs | `dataclasses` (stdlib) | `from_dict()` tự viết, không cần dacite |
| Mã hoá | `cryptography` (Fernet) | Symmetric encryption cho token/password |
| Storage | `sqlite3` (stdlib, ≥3.7) | Lưu profile, token, cache, server URL |
| Output | `json` + `textwrap` (stdlib) | Table/JSON output — không dùng rich |
| Caching | `sqlite3` (stdlib) | TTL-based cache lưu response API |
| Testing | `pytest` + `pytest-httpx` | Mock HTTP calls |
| Packaging | `pyproject.toml` | `pip install -e .` |

> **Zero external deps ngoài `click`, `httpx`, `cryptography`** — tất cả còn lại là stdlib.

### Tại sao SQLite3 thay vì YAML/keyring?
- Hỗ trợ nhiều **profiles** (nhiều server/account)
- Dễ query, migrate schema
- Không phụ thuộc OS-specific credential store
- Token được Fernet-encrypt trước khi INSERT
- **Cache API response** lưu được trong cùng DB, có TTL

### Tại sao `curses` builtin thay vì `urwid`?
- Zero external dependency cho TUI
- Kiểm soát hoàn toàn layout và rendering
- Không cần install thêm gì ngoài Python stdlib

---

## 📁 File Structure

```
cloudbees/
+-- pyproject.toml              # Package config, deps, entry points
+-- Makefile                    # make install | test | lint | dev
+-- README.md
|
+-- cb/                         # Main package
|   +-- __init__.py
|   +-- main.py                 # Entry point: route CLI vs TUI
|   |
|   +-- db/                     # SQLite3 storage layer
|   |   +-- __init__.py
|   |   +-- connection.py       # get_connection(), init_db(), migrations
|   |   +-- schema.sql          # CREATE TABLE (SQLite 3.7 compat)
|   |   +-- repositories/
|   |       +-- profile_repo.py # CRUD profiles (server + credentials)
|   |       +-- token_repo.py   # CRUD API tokens (encrypted)
|   |       +-- cache_repo.py   # CRUD cache entries (TTL-based)
|   |
|   +-- crypto/                 # Ma hoa / giai ma
|   |   +-- __init__.py
|   |   +-- cipher.py           # Fernet encrypt/decrypt wrapper
|   |   +-- key_manager.py      # Derive master key tu login password
|   |
|   +-- cache/                  # Caching layer
|   |   +-- __init__.py
|   |   +-- manager.py          # get_cached(), set_cache(), invalidate()
|   |   +-- policy.py           # TTL constants per resource type
|   |
|   +-- dtos/                   # Data Transfer Objects (dataclasses)
|   |   +-- __init__.py
|   |   +-- base.py             # BaseDTO: from_dict(), to_dict() (stdlib only)
|   |   +-- job.py              # JobDTO, JobRunDTO
|   |   +-- pipeline.py         # PipelineDTO, PipelineRunDTO
|   |   +-- user.py             # UserDTO, TeamDTO
|   |   +-- auth.py             # ProfileDTO, TokenDTO
|   |
|   +-- api/                    # CloudBees REST API Client
|   |   +-- __init__.py
|   |   +-- client.py           # CloudBeesClient (httpx wrapper + cache)
|   |   +-- auth.py             # Load token tu DB -> inject vao header
|   |   +-- exceptions.py       # APIError, AuthError, NotFoundError
|   |
|   +-- services/               # Business logic modules (microservices)
|   |   +-- __init__.py
|   |   +-- auth_service.py     # login(), logout(), switch_profile()
|   |   +-- job_service.py      # list_jobs(), get_job(), trigger_job()
|   |   +-- pipeline_service.py # list_pipelines(), run_pipeline(), get_status()
|   |   +-- user_service.py     # list_users(), get_user(), get_permissions()
|   |   +-- system_service.py   # health_check(), get_version()
|   |
|   +-- cli/                    # CLI Layer (click)
|   |   +-- __init__.py
|   |   +-- root.py             # Root group + global options
|   |   +-- formatters.py       # table | json output (stdlib only)
|   |   +-- commands/
|   |       +-- auth.py         # cb login | logout | profile
|   |       +-- jobs.py         # cb jobs list | get | run | stop
|   |       +-- pipelines.py    # cb pipeline list | run | status
|   |       +-- users.py        # cb users list | get
|   |       +-- system.py       # cb system health | version
|   |
|   +-- tui/                    # TUI Layer (curses builtin)
|       +-- __init__.py
|       +-- app.py              # curses.wrapper(main), signal handlers
|       +-- colors.py           # init_colors(), COLOR_* constants (256)
|       +-- keys.py             # Keybinding constants + help map
|       +-- screens/
|       |   +-- base_screen.py  # Abstract Screen: draw(), handle_key()
|       |   +-- login_screen.py # Login form (URL + password input)
|       |   +-- dashboard.py    # Home: health + quick stats
|       |   +-- jobs.py         # Jobs list + detail pane
|       |   +-- pipelines.py    # Pipelines list + run controls
|       |   +-- users.py        # Users & permissions
|       +-- widgets/
|           +-- header.py       # Top bar: server + profile name
|           +-- sidebar.py      # Nav menu (arrows + number shortcuts)
|           +-- table.py        # Scrollable data table (ASCII borders)
|           +-- input_box.py    # Text input (ASCII border, * password)
|           +-- statusbar.py    # Bottom: keybinding hints
|
+-- tests/
    +-- unit/
    |   +-- test_dtos.py
    |   +-- test_crypto.py
    |   +-- test_db.py
    |   +-- test_cache.py
    |   +-- test_auth_service.py
    |   +-- test_job_service.py
    +-- integration/
        +-- test_api_client.py
```

---

## 📋 Task Breakdown

### Phase 1 — Foundation
> **Goal:** Project skeleton, packaging, SQLite3 schema

- [ ] **T1.1** — Init `pyproject.toml` + entry point `cb`
  - INPUT: deps list
  - OUTPUT: `pip install -e .` → `cb --help` works
  - VERIFY: Command chạy được sau install

- [ ] **T1.2** — `cb/db/` module: `schema.sql` + `connection.py`
  - INPUT: Cần lưu: profiles (name, server_url), tokens (encrypted), sessions
  - OUTPUT: `init_db()` tạo tables tự động, SQLite3 ≥3.7 compatible
  - VERIFY: `pytest tests/unit/test_db.py` — tables tạo đúng, no WAL mode (3.7 compat)

- [ ] **T1.3** -- `cb/crypto/` module: Fernet cipher + key manager
  - INPUT: Master password tu login
  - OUTPUT: `encrypt(token)` -> bytes, `decrypt(blob)` -> str
  - KEY: Derive key tu password bang `PBKDF2HMAC` (salt stored in DB)
  - VERIFY: `pytest tests/unit/test_crypto.py` -- round-trip encrypt/decrypt dung

- [ ] **T1.4** -- `cb/cache/` module: SQLite TTL cache
  - DESIGN: `cache` table: `(key TEXT PK, value TEXT, expires_at INTEGER)`
  - OUTPUT: `get_cached(key)`, `set_cache(key, value, ttl)`, `invalidate(key)`, `purge_expired()`
  - TTL POLICY (policy.py):
    - `jobs.list`     = 60s   (thay doi thuong xuyen)
    - `jobs.detail`   = 30s
    - `pipelines`     = 120s  (it thay doi hon)
    - `users`         = 300s  (it thay doi nhat)
    - `system.health` = 15s   (can fresh)
  - VERIFY: `pytest tests/unit/test_cache.py` -- TTL expire dung, hit/miss OK

- [ ] **T1.4** — Makefile: `make install`, `make test`, `make lint`
  - VERIFY: Mỗi target chạy ra kết quả đúng

---

### Phase 2 — DTOs + API Client + Services
> **Goal:** Business logic layer hoàn chỉnh

- [ ] **T2.1** — `cb/dtos/` — BaseDTO + domain DTOs
  - OUTPUT: `JobDTO`, `PipelineDTO`, `UserDTO`, `ProfileDTO`, `TokenDTO`
  - VERIFY: Round-trip `from_dict(to_dict(dto)) == dto`

- [ ] **T2.2** — `cb/db/repositories/` — profile_repo + token_repo
  - OUTPUT: `save_token(profile, encrypted_blob)`, `get_token(profile) → str`
  - VERIFY: Unit test với in-memory SQLite

- [ ] **T2.3** -- `cb/api/client.py` (httpx wrapper + cache integration)
  - OUTPUT: `CloudBeesClient` voi auto-inject token, retry, timeout
  - CACHE: `GET` requests kiem tra cache truoc khi goi API -> neu hit: return cached DTO
  - INVALIDATE: `POST`/`PUT`/`DELETE` tu dong invalidate cache key lien quan
  - VERIFY: `pytest-httpx` mock -- cache hit khong goi httpx, miss goi dung 1 lan

- [ ] **T2.4** — `auth_service.py`: login flow
  - FLOW: Nhập URL + username + password → auth với CloudBees API → nhận token → Fernet encrypt → lưu SQLite
  - VERIFY: Token trong DB là encrypted blob, không phải plain text

- [ ] **T2.5** — `job_service.py` + `pipeline_service.py`
  - OUTPUT: `list_jobs()`, `trigger_job()`, `list_pipelines()`, `run_pipeline()`
  - VERIFY: Unit tests với mocked `CloudBeesClient`

- [ ] **T2.6** — `user_service.py` + `system_service.py`
  - VERIFY: Unit tests pass

---

### Phase 3 — CLI Layer
> **Goal:** `cb` usable, scriptable

- [ ] **T3.1** — Root CLI + global options
  - OPTIONS: `--profile`, `--output json|table|yaml`, `--url`
  - OUTPUT: Context object chứa config + client
  - VERIFY: `cb --help` format đúng

- [ ] **T3.2** — `cb login` + `cb logout` + `cb profile list`
  - FLOW: Prompt URL + username + password (hidden) → `auth_service.login()`
  - VERIFY: Sau login, `cb profile list` hiện profile mới

- [ ] **T3.3** — `cb jobs` subcommands
  - OUTPUT: `list`, `get <id>`, `run <id>`, `stop <id>`
  - VERIFY: Commands hoạt động với mock server

- [ ] **T3.4** — `cb pipeline` + `cb users` + `cb system`
  - VERIFY: All commands có `--help`, output đúng format

- [ ] **T3.5** -- `formatters.py` -- table/JSON output (stdlib only)
  - TABLE: Ve bang ASCII: +-------+-------+ | col1  | col2  |
  - JSON: `json.dumps(data, indent=2)` voi ensure_ascii=False
  - VERIFY: `--output json` vs `--output table` dung, khong phu thuoc rich

---

### Phase 4 — TUI Layer (curses builtin)
> **Goal:** `cb --ui` → keyboard-driven visual interface

- [ ] **T4.1** — `tui/app.py` — curses bootstrap + signal handlers
  - OUTPUT: `curses.wrapper(main)`, handle `SIGWINCH` resize, thoát bằng `q`
  - VERIFY: `cb --ui` mở terminal, không crash

- [ ] **T4.2** — `colors.py` + base layout: Header + Sidebar + Main + StatusBar
  - OUTPUT: 4-pane layout, `init_colors()` với `curses.color_pair()`
  - VERIFY: Layout render đúng trên terminal 80×24

- [ ] **T4.3** — `login_screen.py` — curses form (URL + password)
  - OUTPUT: Input boxes với `input_box.py` widget, hidden password chars
  - VERIFY: Nhập creds → gọi `auth_service.login()` → redirect dashboard

- [ ] **T4.4** — Sidebar navigation (↑↓ arrows + 1-4 shortcuts)
  - OUTPUT: Highlight active item, switch screens
  - VERIFY: Navigation không crash khi switch nhanh

- [ ] **T4.5** — Dashboard screen + Jobs screen
  - OUTPUT: Health stats, scrollable jobs table, `r` = run, `Enter` = detail
  - VERIFY: Data load, scroll hoạt động

- [ ] **T4.6** — Pipelines screen + Users screen
  - VERIFY: Screens đầy đủ, keyboard actions OK

---

### Phase 5 — Polish & Distribution
> **Goal:** Dễ install, dễ onboard

- [ ] **T5.1** — `cb --version`, update `pyproject.toml` metadata
  - VERIFY: `cb --version` shows correct version

- [ ] **T5.2** — README: Install → Login → CLI reference → TUI guide
  - VERIFY: Người mới setup thành công < 5 phút

---

### Phase X — Verification

- [ ] `pytest tests/` — tất cả unit + integration tests pass
- [ ] `cb login` → token stored encrypted (verify hex blob trong SQLite)
- [ ] `cb jobs list` → data hiển thị đúng
- [ ] `cb --ui` → TUI khởi động, navigate OK, không crash khi resize
- [ ] `python .agent/skills/vulnerability-scanner/scripts/security_scan.py .`
- [ ] Không có plain-text token/password trong logs, DB, hay stdout

---

## ⚡ Agent Assignments

| Phase | Agent | Skills |
|-------|-------|--------|
| 1 | `backend-specialist` | `python-patterns`, `clean-code` |
| 2 | `backend-specialist` | `python-patterns`, `api-patterns` |
| 3 | `backend-specialist` | `clean-code`, `api-patterns` |
| 4 | `backend-specialist` | `python-patterns` (curses focus) |
| 5 | `project-planner` | `documentation-templates` |
| X | `security-auditor` | `vulnerability-scanner`, `testing-patterns` |

---

## TUI Design System (256-Color, ASCII Borders)

> **Target:** 256-color xterm-256color terminal
> **Borders:** ASCII only -- dung +, -, | (khong dung ky tu Unicode)
> **Check:** `curses.COLORS >= 256` -> enable rich palette; else fallback 8-color

### Color Palette (xterm-256color indices)

```
# Backgrounds
BG_BASE        = 234   # #1c1c1c  -- main background (near-black)
BG_SIDEBAR     = 236   # #303030  -- sidebar/panel bg
BG_HEADER      = 24    # #005f87  -- top bar (deep blue)
BG_STATUSBAR   = 238   # #444444  -- bottom bar
BG_SELECTED    = 31    # #0087af  -- selected row
BG_INPUT       = 237   # #3a3a3a  -- input box bg

# Foregrounds
FG_PRIMARY     = 252   # #d0d0d0  -- main text
FG_DIM         = 244   # #808080  -- secondary/dimmed text
FG_ACTIVE      = 214   # #ffaf00  -- active/accent (amber)
FG_SUCCESS     = 82    # #5fd700  -- success green
FG_ERROR       = 196   # #ff0000  -- error red
FG_WARNING     = 220   # #ffd700  -- warning yellow
FG_TITLE       = 255   # #eeeeee  -- titles/headings (white)
FG_KEYHINT     = 39    # #00afff  -- keyboard hint (bright cyan)
```

### Layout (80x24 minimum, scalable) -- ASCII borders

```
+---------------------------------------------------------------+
| CloudBees Manager        server: prod.cb.company.com  [admin] |  <- HEADER
+------------+--------------------------------------------------+
|            |                                                  |
| [1] Dash   |  MAIN CONTENT AREA                               |
| [2] Jobs   |  (scrollable, data tables, detail panes)         |
| [3] Pipes  |                                                  |
| [4] Users  |                                                  |
| [5] System |                                                  |
|            |                                                  |
+------------+--------------------------------------------------+
| q:Quit  Tab:Menu  Enter:Select  r:Run  d:Detail  /:Search     |  <- STATUSBAR
+---------------------------------------------------------------+
```

### ASCII Table Format (CLI + TUI)

```
+--------+--------------------+----------+--------+
| ID     | Name               | Status   | Branch |
+--------+--------------------+----------+--------+
| 1001   | build-main         | SUCCESS  | main   |
| 1002   | test-feature       | RUNNING  | feat/x |
| 1003   | deploy-prod        | FAILED   | main   |
+--------+--------------------+----------+--------+
3 jobs found  (cached 45s ago)
```

### UI Components

| Component | Design Detail |
|-----------|---------------|
| **Header** | Full-width, bg=24 (blue), server URL + user right-aligned |
| **Sidebar** | 12 cols wide, bg=236, active = bg=31 + bold + amber text |
| **Table** | ASCII borders (+---+), header bold+underline, selected=bg31 |
| **Status bar** | bg=238, key hints in cyan (39), current mode in amber (214) |
| **Input box** | ASCII border (+ - |), password chars replaced with `*` |
| **Modal/Dialog** | Centered ASCII box, confirm [Y]/[N] highlighted |
| **Loading** | Spinner: \| / - \ rotated in status bar |
| **Cache indicator** | Hien thi "(cached Xs ago)" sau moi data table |

### Keyboard Map

```
Global:   q = quit  |  Tab = cycle panels  |  / = search
Nav:      up/down = move  |  1-5 = direct screen  |  PgUp/PgDn = scroll
Actions:  Enter = select/open  |  r = run  |  s = stop  |  d = detail
Cache:    F5 = force refresh (bypass cache)  |  C = clear cache
Session:  l = login  |  L = logout  |  p = switch profile
```

---

## ⚠️ Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **SQLite 3.7 compat** | `journal_mode=DELETE` (default), tránh `WITHOUT ROWID`, `STRICT`, `RETURNING` |
| **256-color không có** | `if curses.COLORS < 256: use_8color_fallback()` — define 8-color alt palette |
| **Terminal quá nhỏ** | Check `rows < 24 or cols < 80` → hiện warning và không render TUI |
| **curses crash resize** | Catch `curses.error` + handle `signal.SIGWINCH` → redraw toàn bộ |
| **Master key mất** | Warning khi login: "Re-login will overwrite stored token" — không thể recover |
| **CloudBees API đổi schema** | DTOs có `field(default=None)` cho optional fields + log warning |
| **Token expire** | Check `expires_at` trước mỗi request → auto re-auth hoặc prompt login |
| **Encoding issues** | Force `PYTHONIOENCODING=utf-8`, set locale `LC_ALL=en_US.UTF-8` khi start |
| **Click + curses xung đột** | `cb --ui` không dùng click trong TUI session, chỉ gọi curses.wrapper trực tiếp |
| **HTTP timeout** | httpx default timeout 30s, retry 3 lần với exponential backoff (1s, 2s, 4s) |

---

## 🗄️ SQLite Schema (3.7 Compatible)

```sql
-- schema.sql
CREATE TABLE IF NOT EXISTS profiles (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    server_url TEXT NOT NULL,
    username  TEXT NOT NULL,
    created_at INTEGER NOT NULL  -- Unix timestamp
);

CREATE TABLE IF NOT EXISTS tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    enc_token  BLOB NOT NULL,    -- Fernet-encrypted API token
    salt       BLOB NOT NULL,    -- PBKDF2 salt
    expires_at INTEGER,          -- Unix timestamp, NULL = no expiry
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

> **Note:** Không dùng `WITHOUT ROWID`, `STRICT`, hay `RETURNING` — tất cả là SQLite 3.7 compatible.

---

## 🔐 Crypto Flow

```
Login:
  password (user input)
       ↓
  PBKDF2HMAC(password, salt) → Fernet key
       ↓
  Fernet.encrypt(api_token) → encrypted_blob
       ↓
  SQLite: INSERT INTO tokens (enc_token, salt, ...)

Load:
  password (re-prompt nếu cần) hoặc session key trong memory
       ↓
  PBKDF2HMAC(password, salt from DB) → Fernet key
       ↓
  Fernet.decrypt(enc_token from DB) → api_token
       ↓
  CloudBeesClient(token=api_token)
```

---

## Dependencies

```toml
[project.dependencies]
click        = ">=8.1"
httpx        = ">=0.27"
cryptography = ">=42.0"

[project.optional-dependencies]
dev = ["pytest", "pytest-httpx", "ruff", "mypy"]
```

> **stdlib dung them:** `curses`, `sqlite3`, `dataclasses`, `json`, `textwrap`, `hashlib`, `hmac`, `signal`, `os`, `time`
> **Khong can:** `rich`, `dacite`, `urwid`, `keyring`, `pyyaml`

---

## Architecture Notes

- **Dual-mode entry:** `main.py` -> `--ui` flag -> curses TUI, nguoc lai -> CLI
- **Services UI-agnostic:** Khong import `curses` hay `click`
- **Cache flow:** Service goi `client.get(url)` -> client kiem tra cache -> hit: return; miss: goi API + luu cache
- **Config precedence:** `--profile` flag > `CB_PROFILE` env > default profile trong DB
- **Session memory:** Fernet key chi ton tai trong RAM trong session TUI/CLI, khong persist
- **Cache invalidation:** Moi action write (run, stop) se invalidate cache key lien quan
- **ASCII-only TUI:** Tat ca borders dung +, -, | de dam bao hien thi dung tren moi terminal
