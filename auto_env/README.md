# auto_env - CloudBees automation for RX AUTO

Embeds **CloudBees (`bee`)** as an orchestration layer over **RX AUTO** (another team's verification
environment, see `../../../guide.html`). A single operator edits one config file, then runs three
commands to have CloudBees manage credentials, nodes, and jobs for multiple Linux accounts.

## Layout

```
RX_AUTO/
`--- UTLs/
    `--- Cloudbees/
        |--- bee              <- the bee binary
        |--- rxauto.sh        <- single entry point (auto-detects this dir)
        |--- config.yaml      <- the ONE file you edit
        `--- auto_env/        <- this package
            |--- parse_config.py
            |--- lib.csh  provision.csh  deploy.csh  run.csh  manage.csh
            |--- scripts/setup_all.bash
            |--- claims/      <- runtime claim dirs (trunk/ common/) for work-stealing
            `--- rxews_makefile/apply_makefile_mods.py
```

## Quick start for a new user

### 0. Prerequisites

```bash
bee auth login
bee controller select <your-controller>
```

Make sure `csh`/`tcsh` is installed (`apt install tcsh` if missing).

### 1. Edit config.yaml (once)

`config.yaml` sits next to `rxauto.sh`. The minimum you must fill in:

```yaml
accounts:                          # Linux accounts -> 1 cred + 1 node + 1 job each (manual mode)
  - { username: user01, password: pass01 }
  - { username: user02, password: pass02 }

node:
  host_common: 10.0.0.10           # all nodes SSH to this host (shared filesystem required)
  host_trunk:  10.0.0.20
  port: 22
  remote_dir_base: /home

bs:                                # LSF submit params (used by rx_setup job and step-3 jobs)
  host_groups: "HOSTGR_L HOSTGR_M HOSTGR_S HOSTGR_621910"
  os: REDHATE8
  mem: 8000
  ride_setup: my_ride_setup        # sourced inside tcsh before any RX AUTO script

setup:
  job_name: rx_setup
  account: { username: setupuser, password: setuppass }   # dedicated account for step 1-2
```

Everything in `setup.vars` (S2 env vars) is **auto-derived** from `RX_AUTO_ROOT` — leave them `""`
unless you need to override a specific value:

| Variable | Auto value |
|---|---|
| `RX_AUTO_ROOT` | from `RXAUTO_ROOT` env (exported by `rxauto.sh`) |
| `TRUNK_IP_RXEWS_RUN_DIR_PATH` | `$RX_AUTO_ROOT/rxews_trunk_ip_vnet_` |
| `COMMON_RXEWS_RUN_DIR_PATH` | `$RX_AUTO_ROOT/rxews_trunk_vnet_wk_` |
| `TRUNK_IP_ENV_BASE` | `<trunk_dir>/RxEnv-Trunk-IP-VNET-<REV>` (REV read from Makefile) |
| `COMMON_ENV_BASE` | `<common_dir>/RxEnv-Trunk-VNET-<REV>` (REV read from Makefile) |
| `DEDICATED_SV` | `HOSTGR_L HOSTGR_M HOSTGR_S HOSTGR_621910` |
| `RIDE_ENV_VER` | `WK18` |
| `DASHBOARD_DB_LOCATION` | `$RX_AUTO_ROOT/dashboard_db` |
| `COMMON_RUN_TYPE` | `Trunk` (fixed) |

### 2. Provision (once, or when accounts change)

```bash
rxauto.sh provision
```

Creates: CloudBees folder → credential + SSH node for **every** account in `accounts:` **and**
`setup.account`. Writes `auto_env/complete.yml` (the manifest). Idempotent — existing creds/nodes
are reused.

### 3. Deploy (once, or when mode/ip changes)

```bash
rxauto.sh deploy
```

Creates/updates all jobs on CloudBees:
- `rx_setup` — runs RX AUTO step 1-2 on the setup node
- `build_<user>` (manual mode) or `daily` (auto mode) — step-3 jobs

### 4. Run step 1-2: trigger rx_setup (once per environment)

```bash
rxauto.sh bee job run rx_setup
# or click the job in the CloudBees UI
```

The job runs on the dedicated setup node:
```
bs ... tcsh -f -c 'source my_ride_setup; source ./my_cmd; source ./my_cmd_for_common;
  <S4 Makefile mods on both RXEWS dirs>; <make general/auto/server targets>'
```

**Wait for this job to finish before running step 3.**

S4 changes applied automatically (both trunk IP and common IP dirs):
- `OS_TYPE_SETUP`: `"RHEL7"` → `"RHEL8"`
- `RDFS_ALTERNATIVE_CLOCK_GENERATION`: `0` → `1`
- `BS_PY3`, `BSIQ`, `BSBQ`: adds `-m "<DEDICATED_SV>"` to each `bs` command
- `GPUBASE`, `MASTER_LIST`, `MASTER_RTL`, `MASTER_BBOX`, `MASTER_RTL_*`: per-dir IP variants

### 5. Run step 3

**manual mode:**
```bash
rxauto.sh run              # triggers all build_* jobs with IP_MODE from config
rxauto.sh run --ip trunk   # override IP_MODE for this run only
rxauto.sh run --ip all     # run trunk AND common
```

Each job claims split files from `SUBMIT_LIST/NORMAL|COMMON/` (atomic `mkdir` into
`auto_env/claims/<ip_mode>/`) and submits each via LSF:
```
bs ... tcsh -f -c "source my_ride_setup; bash rx_run <file>"
```

**auto mode:** no manual trigger needed — the `daily` job fires on schedule (e.g. every 30 min)
and runs `go_rx_auto` which detects SVN changes, queues, and runs everything.

---

## Re-run and maintenance

| Situation | Command |
|---|---|
| Run step 3 again | `rxauto.sh run` |
| Environment changed (new SVN rev) | trigger `rx_setup` again, then `rxauto.sh run` |
| Switch trunk ↔ common (manual) | `rxauto.sh run --ip trunk\|common` (no redeploy needed) |
| Switch trunk ↔ common (auto) | edit `ip_mode:` in config, `rxauto.sh deploy` |
| Switch manual ↔ auto | edit `mode:` in config, `rxauto.sh deploy` (old jobs kept, schedule cleared) |
| Delete stale jobs/nodes/creds | `rxauto.sh prune --dry-run` then `rxauto.sh prune` |
| Teardown everything | `rxauto.sh manage teardown` |
| Check what exists | `rxauto.sh manage list` |

## Two modes

- **manual** — N accounts → N nodes → N jobs, **work-stealing**. Jobs run in parallel; each
  claims the next unclaimed split file (atomic `mkdir` in `auto_env/claims/<ip_mode>/`) until all
  files are processed. More accounts = more parallelism.
- **auto** — 1 dedicated account → 1 node → 1 scheduled job running `go_rx_auto` (detects SVN
  changes and orchestrates the full run automatically).

`IP_MODE=trunk` → `01_*` scripts; `IP_MODE=common` → `02_*` scripts.

## Alternative: run step 1-2 by hand (outside CloudBees)

If you prefer not to use the `rx_setup` job, run `setup_all.bash` directly after sourcing RiDE:

```bash
# prereq: source my_ride_setup && source ./my_cmd && source ./my_cmd_for_common
bash auto_env/scripts/setup_all.bash all --dry-run   # preview
bash auto_env/scripts/setup_all.bash all             # run for real
# phases: makefile | general | auto | server | all
```

## Avoiding name clashes

Change `base_name` in config (e.g. `RX_AUTO` → `RX_AUTO_v2`). Folder/node/job all use it as
prefix, so a new name is a fresh namespace that never overwrites the previous round.

## Environment notes

1. **Shared filesystem** — all nodes must SSH to the same host so `SUBMIT_LIST/` and
   `auto_env/claims/` are physically the same directory for every worker.
2. **`csh`/`tcsh` must be installed** — `apt install tcsh` if missing.
3. **SSH password auth** — `sshd` must allow `PasswordAuthentication yes` on the target host
   (or use SSH keys). `provision.csh` warns when `host=localhost`.
4. **YAML** — no `yq` needed; parsed with `python3 + pyyaml`.

## Files

| File | Role |
|---|---|
| `../config.yaml` | the ONE file you edit: accounts, node, mode, `bs:` params, `setup:` vars & Makefile changes |
| `parse_config.py` | brain: parse YAML, emit action lines for csh scripts, b64-encode commands, write manifest |
| `lib.csh` | resolve `bee` binary, select controller, set `$CONFIG` / `$MANIFEST` |
| `provision.csh` | create folder + cred + node per account, write `complete.yml` |
| `deploy.csh` | create/update jobs (`rx_setup` + step-3 jobs); clear schedule on stale jobs |
| `run.csh` | trigger step-3 jobs (manual mode) |
| `manage.csh` | `list` / `teardown` / `prune` from the manifest |
| `scripts/setup_all.bash` | manual alternative for step 1-2 (outside CloudBees) |
| `rxews_makefile/apply_makefile_mods.py` | applies S4 Makefile changes to both RXEWS dirs (backup, dry-run, idempotent) |
| `claims/` | runtime claim dirs: `trunk/` and `common/` — one subdir per claimed split file |
| `complete.yml` | manifest: folder, cred-ids, node names, job names (written by provision/deploy) |
