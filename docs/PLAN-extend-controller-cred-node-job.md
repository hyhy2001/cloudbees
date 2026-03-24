# CloudBees CLI+TUI — Extension Plan
# Controller / Credential / Node / Job Management
# v2 — refined spec (2026-03-24)

> **Type:** Feature Extension (existing codebase)
> **Base Plan:** `docs/PLAN-cloudbees-cli-tui.md`
> **Updated:** 2026-03-24
> **Agent:** `backend-specialist`

---

## Python 3.10 Compatibility

> **TL;DR: 100% tuong thich. Khong can chinh sua gi.**

| Feature | 3.8 (hien tai) | 3.10 (server cty) |
|---------|----------------|-------------------|
| `from __future__ import annotations` | Bat buoc | Van OK |
| `X \| None` native syntax | Runtime error | OK native |
| `dict[str, int]` lowercase | Runtime error | OK native |
| `match/case` | Khong co | Co (ta khong dung) |
| `curses`, `sqlite3`, `dataclasses` | OK | OK |

Code hien tai dung `from __future__ import annotations` nen chay
tot tren Python 3.8, 3.9, **3.10**, 3.11, 3.12.

---

## Muc tieu mo rong (Scope da xac nhan)

```
1. CONTROLLER  -> Chon controller de lam viec (Operations Center)
2. CREDENTIAL  -> Tao (username+password), list, get, delete
3. NODE        -> Tao permanent agent / copy existing, list, get, delete, offline
4. JOB         -> Tao (Freestyle / Pipeline / Folder), list, get, delete,
                  run, stop, log, status
```

**Bo**: `cb pipeline` (thay bang `cb job` toan dien hon)
**Giu**: `cb system`, `cb users`, `cb auth` — khong doi

---

## Quyet dinh thiet ke (Confirmed)

| Feature | Quyet dinh |
|---------|------------|
| Credential types | Chi `UsernamePassword` (`create` voi `--username` + `--password`) |
| Node types | Permanent Agent + Copy from existing node (`--copy-from`) |
| Job types | Freestyle / Pipeline / Folder |
| `list`, `get`, `delete`, `stop`, `log`, `status` | Giu nhu dinh nghia o Phase D |

---

## CloudBees REST API Reference

### Controller API

```
GET  /api/json?tree=jobs[_class,name,url,description]
     -> List tat ca items (filter theo _class de tim controllers)
GET  /job/{ctrl}/api/json         -> Controller detail
GET  /crumbIssuer/api/json        -> CSRF crumb (bat buoc truoc moi POST)
```

### Credential API

```
GET  /credentials/store/system/domain/_/api/json
     -> List credentials

POST /credentials/store/system/domain/_/createCredentials
     Body: XML
     -> Tao moi (UsernamePassword)

POST /credentials/store/system/domain/_/{id}/doDelete
     -> Xoa credential

GET  /credentials/store/system/domain/_/{id}/api/json
     -> Chi tiet (password bi che, hien [HIDDEN])
```

Config XML cho UsernamePassword:
```xml
<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
  <scope>GLOBAL</scope>
  <id>{id}</id>
  <description>{desc}</description>
  <username>{username}</username>
  <password>{password}</password>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
```

### Node / Agent API

```
GET  /computer/api/json                  -> List nodes
GET  /computer/{name}/api/json           -> Node detail
GET  /computer/{name}/config.xml         -> Lay config XML (dung cho copy)
POST /computer/doCreateItem              -> Tao node moi
     Params: name=<name>, type=hudson.slaves.DumbSlave
     Body: JSON config
POST /computer/{source}/doDelete         -> Xoa node
POST /computer/{name}/toggleOffline?offlineMessage=... -> Toggle offline
```

Tao node kieu "copy existing":
```
GET /computer/{source}/config.xml   -> Lay XML
Thay doi <name> va cac truong can thiet
POST /computer/doCreateItem         -> Tao node moi voi XML da chinh sua
```

### Job API

```
GET  /api/json?tree=jobs[_class,name,url,color,description,lastBuild[number,result]]
     -> List jobs (tat ca loai)

GET  /job/{name}/api/json            -> Job detail
POST /createItem?name={name}         -> Tao job (body = config.xml)
POST /job/{name}/doDelete            -> Xoa job
POST /job/{name}/build               -> Run job
POST /job/{name}/{build#}/stop       -> Stop build
GET  /job/{name}/{build#}/consoleText -> Console log
GET  /job/{name}/{build#}/api/json   -> Build detail
```

Job types va config XML:

**Freestyle:**
```xml
<?xml version='1.1' encoding='UTF-8'?>
<project>
  <description>{desc}</description>
  <builders>
    <hudson.tasks.Shell>
      <command>{shell_cmd}</command>
    </hudson.tasks.Shell>
  </builders>
</project>
```

**Pipeline:**
```xml
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>{desc}</description>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition">
    <script>{pipeline_script}</script>
    <sandbox>true</sandbox>
  </definition>
</flow-definition>
```

**Folder:**
```xml
<?xml version='1.1' encoding='UTF-8'?>
<com.cloudbees.hudson.plugins.folder.Folder plugin="cloudbees-folder">
  <description>{desc}</description>
</com.cloudbees.hudson.plugins.folder.Folder>
```

---

## File Structure (additions only)

```
cb/
+-- dtos/
|   +-- controller.py      # ControllerDTO
|   +-- credential.py      # CredentialDTO (UsernamePassword focus)
|   +-- node.py            # NodeDTO, NodeDetailDTO
|   +-- job.py             # [update] BuildDTO, JobConfigDTO them vao
|
+-- api/
|   +-- crumb.py           # CSRF crumb fetcher (cache 5 phut)
|   +-- xml_builder.py     # Tao config.xml (stdlib xml.etree)
|
+-- services/
|   +-- controller_service.py  # list, get, select, get_active
|   +-- credential_service.py  # list, get, create_username_password, delete
|   +-- node_service.py        # list, get, create_permanent, copy, delete, toggle
|   +-- job_service.py         # [update] create_freestyle/pipeline/folder,
|                              #          delete, get_build_log, wait_for_build
|
+-- cli/
|   +-- commands/
|       +-- controller.py  # cb controller list|info|select|current
|       +-- credentials.py # cb cred list|get|create|delete
|       +-- nodes.py       # cb node list|get|create|copy|delete|offline|online
|       +-- jobs.py        # [update full] cb job ...
|
+-- tui/
    +-- screens/
    |   +-- screens.py     # [update] +ControllerScreen, CredScreen, NodeScreen
    +-- widgets/
        +-- form.py        # MultiFieldForm widget (Tab navigation)
```

---

## Task Breakdown

### Phase A — Foundation cho API moi

- [ ] **A1** — `cb/api/crumb.py`: CSRF crumb fetcher
  - CloudBees bat buoc crumb truoc moi POST/DELETE
  - FLOW: `GET /crumbIssuer/api/json` -> lay `crumb` + `crumbRequestField`
  - Cache trong RAM 5 phut (per client instance)
  - Auto-retry: nhan 403 -> fetch crumb moi -> retry 1 lan
  - OUTPUT: `get_crumb(client) -> dict | None`
  - VERIFY: POST khong bi 403 CSRF error

- [ ] **A2** — `cb/api/xml_builder.py`: Config XML generator
  - Dung `xml.etree.ElementTree` (stdlib, khong can lxml)
  - OUTPUT functions:
    - `build_freestyle_xml(desc, shell_cmd) -> str`
    - `build_pipeline_xml(desc, script) -> str`
    - `build_folder_xml(desc) -> str`
    - `build_username_password_cred_xml(id, username, password, desc) -> str`
    - `build_permanent_node_xml(name, remote_dir, num_exec, labels, desc) -> str`
    - `patch_node_xml(source_xml, new_name) -> str`  # dung cho copy node
  - VERIFY: XML hop le, parse duoc boi ElementTree

- [ ] **A3** — Update `cb/api/client.py`
  - Them `post_xml(path, xml_str, **kwargs) -> Any`
    - Content-Type: `text/xml;charset=UTF-8`
    - Tu dong inject crumb header
  - Update `post()` va `delete()` -> tu dong inject crumb
  - VERIFY: POST XML -> 200/201 voi mock server

---

### Phase B — DTOs

- [ ] **B1** — `cb/dtos/controller.py`
  ```
  ControllerDTO:
    name: str
    url: str
    description: str
    class_name: str   # _class field tu API
    online: bool = True
  ```

- [ ] **B2** — `cb/dtos/credential.py`
  ```
  CredentialDTO:
    id: str
    display_name: str
    type_name: str    # e.g. "Username with password"
    scope: str        # GLOBAL / SYSTEM
    description: str
  ```
  Chi mot loai (UsernamePassword) — mo rong sau.

- [ ] **B3** — `cb/dtos/node.py`
  ```
  NodeDTO:
    name: str
    display_name: str
    offline: bool
    num_executors: int
    labels: str       # space-separated labels
    description: str

  NodeDetailDTO(NodeDTO):
    launcher_type: str    # ssh / jnlp / command
    remote_dir: str
    config_xml: str       # raw XML, dung cho copy
  ```

- [ ] **B4** — Update `cb/dtos/job.py`
  ```
  # Them vao JobDTO:
  job_class: str = ""   # Freestyle / WorkflowJob / Folder

  # Moi:
  BuildDTO:
    number: int
    result: str | None    # SUCCESS / FAILURE / ABORTED / None
    building: bool
    duration: int
    timestamp: int
    url: str

  JobConfigDTO:
    name: str
    job_type: str         # freestyle | pipeline | folder
    description: str
  ```

- [ ] **B5** — `tests/unit/test_dtos_ext.py`
  - Test from_dict cho ControllerDTO, CredentialDTO, NodeDTO, BuildDTO
  - VERIFY: `pytest tests/unit/test_dtos_ext.py` 100% pass

---

### Phase C — Services

- [ ] **C1** — `cb/services/controller_service.py`
  ```python
  list_controllers(client) -> list[ControllerDTO]
  get_controller(client, name) -> ControllerDTO
  select_controller(name, url, db_path) -> None
    # -> luu vao settings: active_controller, active_controller_url
  get_active_controller(db_path) -> tuple[str, str] | None
    # -> (name, url)
  ```
  - CACHE: `controllers.list` TTL=120s
  - VERIFY: select -> luu DB, get_active -> doc lai dung

- [ ] **C2** — `cb/services/credential_service.py`
  ```python
  list_credentials(client) -> list[CredentialDTO]
  get_credential(client, cred_id) -> CredentialDTO
  create_username_password(client, cred_id, username, password, desc) -> None
    # -> POST XML toi /credentials/store/system/domain/_/createCredentials
  delete_credential(client, cred_id) -> None
    # -> POST /credentials/store/system/domain/_/{id}/doDelete
  ```
  - POST -> tu dong inject CSRF crumb
  - Write ops -> invalidate `credentials.*` cache
  - VERIFY: Unit tests voi mocked client

- [ ] **C3** — `cb/services/node_service.py`
  ```python
  list_nodes(client) -> list[NodeDTO]
  get_node(client, name) -> NodeDetailDTO
    # -> GET /computer/{name}/api/json + /computer/{name}/config.xml
  create_permanent_node(client, name, remote_dir,
                        num_executors, labels, desc) -> None
    # -> POST /computer/doCreateItem voi XML
  copy_node(client, source_name, new_name) -> None
    # -> GET config.xml cua source -> patch name -> POST doCreateItem
  delete_node(client, name) -> None
  toggle_offline(client, name, reason) -> None
    # -> POST /computer/{name}/toggleOffline?offlineMessage={reason}
  toggle_online(client, name) -> None
    # -> POST /computer/{name}/toggleOffline (khi da offline -> se online)
  ```
  - CACHE: `nodes.list` TTL=30s, `nodes.detail.*` TTL=15s
  - Write ops -> invalidate `nodes.*`
  - VERIFY: Unit tests pass

- [ ] **C4** — Update `cb/services/job_service.py`
  ```python
  # Them moi:
  create_freestyle_job(client, name, desc, shell_cmd) -> None
  create_pipeline_job(client, name, desc, script) -> None
  create_folder(client, name, desc) -> None
  delete_job(client, name) -> None
  get_build_detail(client, job_name, build_number) -> BuildDTO
  get_build_log(client, job_name, build_number) -> str
    # -> GET /job/{name}/{build#}/consoleText
  get_last_build_number(client, job_name) -> int | None
  wait_for_build(client, job_name, build_number, timeout=120) -> BuildDTO
    # -> Poll moi 5s den khi building=False hoac timeout
  ```
  - Tao job -> invalidate `jobs.*` cache
  - VERIFY: Unit tests pass (mock client)

---

### Phase D — CLI Commands

- [ ] **D1** — `cb/cli/commands/controller.py`
  ```
  cb controller list [-o table|json]
    -> Bang: Name | URL | Description | Active(*)

  cb controller info <name>
    -> Chi tiet controller (key-value)

  cb controller select <name>
    -> Chon controller lam active
    -> Luu vao SQLite settings
    -> In: [OK] Active controller: <name> (<url>)

  cb controller current
    -> In: Controller dang active va URL
  ```
  - VERIFY: `cb controller --help` + moi subcommand co `--help`

- [ ] **D2** — `cb/cli/commands/credentials.py`
  ```
  cb cred list [-o table|json]
    -> Bang: ID | Type | Description | Scope

  cb cred get <id> [-o table|json]
    -> Chi tiet, password hien [HIDDEN]

  cb cred create [OPTIONS]
    -> --id TEXT (required)
    -> --username TEXT (required)
    -> --password TEXT (prompt nen dung hide_input=True)
    -> --description TEXT (optional)
    -> Neu thieu -> prompt interactive

  cb cred delete <id> [--yes]
    -> Confirm: "Delete credential '<id>'? [y/N]"
    -> --yes de skip confirm (dung trong script)
  ```
  - SECURITY: password LUON `hide_input=True`, khong bao gio log ra
  - VERIFY: `cb cred create` -> xuat hien trong `cb cred list`

- [ ] **D3** — `cb/cli/commands/nodes.py`
  ```
  cb node list [-o table|json]
    -> Bang: Name | Status | Executors | Labels | Description
    -> Status color: ONLINE (green), OFFLINE (red), DISCONNECTED (yellow)

  cb node get <name> [-o table|json]
    -> Chi tiet node bao gom launcher type, remote dir

  cb node create [OPTIONS]
    -> --name TEXT        (required)
    -> --remote-dir TEXT  (required, e.g. /home/jenkins)
    -> --executors INT    (default: 1)
    -> --labels TEXT      (e.g. "linux docker", optional)
    -> --description TEXT (optional)
    -> Tao Permanent Agent voi JNLPLauncher (pho bien nhat)

  cb node copy <source-name> <new-name>
    -> Copy config tu <source-name>
    -> Dat lai ten thanh <new-name>
    -> [OK] Node '<new-name>' created (copied from '<source-name>')

  cb node delete <name> [--yes]
    -> Confirm truoc khi xoa

  cb node offline <name> [--reason TEXT]
    -> Toggle ve offline voi ly do

  cb node online <name>
    -> Toggle ve online
  ```
  - VERIFY: `cb node --help`, create + list hoat dong

- [ ] **D4** — Update `cb/cli/commands/jobs.py` (viet lai hoan toan)
  ```
  cb job list [-o table|json]
    -> Bang: Name | Type | Status | Build# | Description
    -> Type hien ngan: FS=Freestyle, PL=Pipeline, FD=Folder

  cb job get <name> [-o table|json]
    -> Chi tiet job + last build info

  cb job create freestyle <name> [OPTIONS]
    -> --description TEXT
    -> --shell TEXT (shell command, prompt neu thieu)

  cb job create pipeline <name> [OPTIONS]
    -> --description TEXT
    -> --script TEXT (pipeline script, prompt neu thieu)
    -> --script-file PATH (doc tu file thay vi prompt)

  cb job create folder <name> [OPTIONS]
    -> --description TEXT

  cb job delete <name> [--yes]
    -> Confirm truoc khi xoa

  cb job run <name> [--wait] [--timeout INT]
    -> Trigger build
    -> --wait: doi den khi build xong (spinner trong status bar)
    -> --timeout: thoi gian cho toi da (default 120s)
    -> In ket qua: SUCCESS / FAILURE / ABORTED

  cb job stop <name> <build-number>
    -> Dung build dang chay

  cb job log <name> [build-number] [--follow]
    -> In console log
    -> build-number mac dinh la build moi nhat
    -> --follow: stream log theo thoi gian thuc (poll moi 2s)

  cb job status <name>
    -> Hien thi build history:
    -> Bang: Build# | Result | Duration | Timestamp
    -> Last 10 builds
  ```
  - VERIFY: Toan bo subcommands co `--help`, chay khong crash

---

### Phase E — TUI Screens (mo rong)

- [ ] **E1** — `ControllerScreen` trong `screens.py`
  - List controllers, hien `*` ben canh controller dang active
  - `Enter` = chon lam active controller -> cap nhat settings + status bar
  - `r` = refresh list

- [ ] **E2** — `CredentialsScreen` trong `screens.py`
  - List credentials: ID | Type | Description | Scope
  - `c` = mo form tao credential (username+password)
  - `d` = delete voi confirm dialog
  - `Enter` = xem chi tiet (password hien `[HIDDEN]`)

- [ ] **E3** — `NodesScreen` trong `screens.py`
  - List nodes voi color: ONLINE=green, OFFLINE=red
  - `c` = tao node moi (form)
  - `C` = copy node (nhap source + new name)
  - `o` = toggle offline/online
  - `d` = delete voi confirm

- [ ] **E4** — Update `JobsScreen` trong `screens.py`
  - Them cot Type: `FS` / `PL` / `FD`
  - `c` = tao job -> chon loai (Freestyle/Pipeline/Folder) -> form
  - `d` = delete voi confirm
  - `l` = xem log build cuoi
  - `s` = xem status (build history)
  - `Enter` = chi tiet job

- [ ] **E5** — `cb/tui/widgets/form.py`: `MultiFieldForm` widget
  ```
  class FormField:
    label: str
    value: str
    secret: bool = False    # hien thi * thay vi ky tu that
    required: bool = True

  class MultiFieldForm:
    title: str
    fields: list[FormField]
    Tab / Down -> next field
    Up -> prev field
    Enter -> submit (validate required fields)
    Esc -> cancel
    BACKSPACE -> xoa ky tu
  ```
  - Tai su dung cho: Create Credential / Create Node / Create Job

- [ ] **E6** — Cap nhat sidebar navigation `tui/app.py`:
  ```
  [1] Dashboard
  [2] Controllers  <- MOI
  [3] Jobs
  [4] Credentials  <- MOI
  [5] Nodes        <- MOI
  [6] Users
  [7] System
  ```
  - F5 = force refresh man hinh hien tai
  - C = xoa cache

---

### Phase F — Active Controller Settings

- [ ] **F1** — `cb/db/repositories/settings_repo.py` (moi)
  ```python
  get_setting(key, db_path) -> str | None
  set_setting(key, value, db_path) -> None
  ```
  - Dung `settings` table da co trong schema.sql

- [ ] **F2** — Update `cb/main.py`
  ```python
  @click.option("--controller", "-c", default=None, envvar="CB_CONTROLLER",
                help="Active controller name")
  ```
  - Khi build client: neu co `--controller` -> lookup URL trong settings
  - Fallback: dung profile server_url truc tiep

- [ ] **F3** — Update `cb/services/auth_service.get_client()`
  - Them `controller` param -> append controller path vao base URL
  - e.g. `https://ops.company.com` + `my-controller` -> `https://ops.company.com/job/my-controller`

---

### Phase X — Verification Checklist

**CLI:**
- [ ] `cb controller list` -> bang hien dung
- [ ] `cb controller select <name>` -> luu active, hien trong `cb controller current`
- [ ] `cb cred list` -> bang hien dung
- [ ] `cb cred create --id x --username u` -> prompt password (hidden) -> tao thanh cong
- [ ] `cb cred delete x` -> confirm + xoa
- [ ] `cb node list` -> bang voi status online/offline
- [ ] `cb node create` -> tao permanent agent thanh cong
- [ ] `cb node copy <src> <new>` -> node moi xuat hien trong list
- [ ] `cb node offline <name>` -> node bien thanh offline
- [ ] `cb job list` -> hien Freestyle / Pipeline / Folder
- [ ] `cb job create freestyle <name>` -> job xuat hien trong list
- [ ] `cb job create pipeline <name> --script-file Jenkinsfile` -> tao thanh cong
- [ ] `cb job create folder <name>` -> folder xuat hien trong list
- [ ] `cb job run <name>` -> trigger build
- [ ] `cb job run <name> --wait` -> doi ket qua in SUCCESS/FAILURE
- [ ] `cb job stop <name> <build#>` -> stop build
- [ ] `cb job log <name>` -> in console log
- [ ] `cb job log <name> --follow` -> stream log
- [ ] `cb job status <name>` -> build history table

**TUI:**
- [ ] `cb --ui` -> sidebar co 7 items
- [ ] Controllers screen: load + Enter chon active
- [ ] Credentials screen: list + 'c' mo form tao + 'd' xoa
- [ ] Nodes screen: list voi color + 'c' tao + 'C' copy + 'o' toggle
- [ ] Jobs screen: cot Type hien dung, 'c' tao, 'l' log

**Security:**
- [ ] `cb cred create` khong bao gio hien password ben ngoai
- [ ] `cb cred get` hien `[HIDDEN]` cho password field
- [ ] Tokens/passwords khong xuat hien trong log, stdout, DB dang plaintext

**Tests:**
- [ ] `pytest tests/unit/` -> 100% pass
- [ ] `pytest tests/unit/test_dtos_ext.py` -> ControllerDTO, NodeDTO, BuildDTO

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| CSRF crumb het han | Auto-retry 1 lan khi nhan 403 -> fetch crumb moi |
| XML format khac CB version | Test voi XML toi gian nhat, fallback graceful |
| Password lo ra log | `hide_input=True` + khong log credentials field |
| Copy node: URL path khac | Thu `GET /computer/{name}/config.xml` + xem status code |
| Controller URL path khac nhau | Ho tro ca `job/{ctrl}` va `/{ctrl}` path |
| Node chua connect sau khi tao | In huong dan JNLP secret URL sau khi tao |
| Job create bi reject (plugin thieu) | Bat loi APIError 400 + hien thong bao ro rang |

---

## Cache TTL (cap nhat)

```python
TTL = {
    # existing
    "jobs.list":           60,
    "jobs.detail":         30,
    "users.list":          300,
    "system.health":       15,
    # new
    "controllers.list":    120,
    "credentials.list":     60,
    "credentials.detail":  120,
    "nodes.list":           30,   # online/offline thay doi nhanh
    "nodes.detail":         15,
}
```

---

## Dependencies (khong thay doi)

```toml
[project.dependencies]
click        = ">=8.1"
httpx        = ">=0.27"
cryptography = ">=42.0"
# stdlib: curses, sqlite3, dataclasses, json, xml.etree.ElementTree, textwrap
```

> **Zero external deps moi.** `xml.etree.ElementTree` la stdlib Python.

---

## Agent Assignments

| Phase | Agent | Skills |
|-------|-------|--------|
| A | `backend-specialist` | `api-patterns`, `python-patterns` |
| B | `backend-specialist` | `clean-code`, `python-patterns` |
| C | `backend-specialist` | `api-patterns`, `testing-patterns` |
| D | `backend-specialist` | `clean-code`, `python-patterns` |
| E | `backend-specialist` | `python-patterns` (curses) |
| F | `backend-specialist` | `clean-code` |
| X | `security-auditor` | `vulnerability-scanner` |
