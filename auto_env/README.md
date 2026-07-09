# auto_env - CloudBees automation for RX AUTO

Embeds **CloudBees (`bee`)** as an orchestration layer over **RX AUTO** (another team's verification
environment, see `../../../guide.html`). A single operator edits one config file, then runs three
commands to have CloudBees manage credentials, nodes, and jobs for multiple Linux accounts.

## Layout

`RX_AUTO_ROOT` is the top dir that holds `rxauto.sh` + `config.yaml` — and also
the RX AUTO shell-init files (`my_ride_setup`, `my_cmd`, `my_cmd_for_common`),
the Makefile with the setup targets, the `rxews_*` dirs, `dashboard_db` and
`SUBMIT_LIST`. Only the `01_*/02_*` rx_run scripts live one level down, in the
`RX_AUTO/` subdir (which in turn holds `UTLs/Cloudbees/`).

```
RX_AUTO_ROOT/                 <- rxauto.sh, config.yaml, my_ride_setup, my_cmd,
│                                my_cmd_for_common, Makefile, rxews_*, dashboard_db, SUBMIT_LIST
`--- RX_AUTO/                 <- 01_*/02_* rx_run + go_rx_auto scripts
     `--- UTLs/
         `--- Cloudbees/
             |--- bee                 <- the bee binary
             |--- complete.yml        <- manifest (written by provision/deploy)
             `--- auto_env/           <- this package
                 |--- parse_config.py
                 |--- lib.csh  provision.csh  deploy.csh  run.csh  manage.csh
                 |--- pause.csh  resume.csh
                 |--- scripts/setup_all.bash
                 `--- rxews_makefile/apply_makefile_mods.py
```

`rxauto.sh` exports `RXAUTO_ROOT` (the dir it lives in) so every step resolves
these paths consistently. Override with `rx_auto_root:` in config.yaml.

## Quick start for a new user

### 0. Prerequisites

```bash
rxauto.sh bee auth login
rxauto.sh bee controller select <your-controller>
```

Do this **once**. bee remembers the active controller in its session, so the
provision/deploy/run steps don't re-select it.

Make sure `csh`/`tcsh` is installed (`apt install tcsh` if missing).

### 1. Edit config.yaml (once)

`config.yaml` sits next to `rxauto.sh`. The minimum you must fill in:

```yaml
mode: manual                       # manual | auto  (see "manual vs auto" below)
ip_mode: common                    # common | trunk | all

accounts:                          # manual mode: Linux accounts -> 1 cred + 1 node + 1 job each
  - { username: user01, password: pass01 }
  - { username: user02, password: pass02 }

node:
  host: 10.0.0.10                  # all nodes SSH to this host (shared filesystem required)
  port: 22

bs:                                # LSF submit params (used by rx_setup job and step-3 jobs)
  host_groups: "HOSTGR_L HOSTGR_M HOSTGR_S HOSTGR_621910"
  os: REDHATE8
  mem: 8000
  ride_setup: my_ride_setup        # sourced inside tcsh before any RX AUTO script

manual:                            # used when mode: manual
  job_prefix: build                # job names become build_<username>
  wait: false                      # true = bee job run --wait (block per build)

auto:                              # used when mode: auto
  account: { username: user11, password: pass11, executors: 2 }  # dedicated account+node
  job_name: daily                  # ip=all -> daily_trunk + daily_common
  schedule: "H/30 * * * *"         # cron: how often go_rx_auto fires

setup:
  job_name: rx_setup
  account: { username: setupuser, password: setuppass }   # dedicated account for step 1-2
```

**Which of `accounts:` / `auto:` you fill depends on `mode:`** — see the next section.

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

#### manual vs auto — which fields matter

`mode:` decides how step 3 runs. Fill the block for the mode you pick; the other
block is ignored.

| | **manual** (`mode: manual`) | **auto** (`mode: auto`) |
|---|---|---|
| Fill in | `accounts:` (N Linux accounts) + `manual:` | `auto:` (one dedicated account) |
| Jobs created | one `build_<user>` per account | `daily` (or `daily_trunk`+`daily_common` if `ip_mode: all`) |
| How step 3 runs | you trigger it: `rxauto.sh run` distributes the pre-split module files round-robin across the `build_*` jobs; each build submits one file via LSF | the `daily` job fires on `auto.schedule` and runs `go_rx_auto`, which detects SVN changes and orchestrates everything itself |
| Parallelism | N accounts = N nodes running in parallel (each `executors=1`, so files queue per node) | one node with `executors: 2` so trunk + common can run together |
| `ip_mode` | picked at run time: `rxauto.sh run --ip trunk\|common\|all` (no redeploy) | baked into the job(s) at deploy time; change `ip_mode:` then `rxauto.sh deploy` |
| Stop / resume | n/a (you control when to run) | `rxauto.sh pause` / `rxauto.sh resume` (clear/restore the schedule) |

`ip_mode` in both modes: `trunk` → `01_*` scripts, `common` → `02_*` scripts,
`all` → both. Switch mode any time by editing `mode:` and running `rxauto.sh deploy`
(old-mode jobs are kept but their schedule is cleared; use `prune` to delete them).

### Fast path: one command for everything

Once config.yaml is filled in and you've logged in (step 0), you can run the
whole pipeline in one go:

```bash
rxauto.sh all      # provision -> deploy -> rx_setup (waits for it) -> run step 3
```

`all` stops at the first failing step. Prefer it for a first run; the numbered
steps below are for re-running or understanding each stage individually.

### 2. Provision (once, or when accounts change)

```bash
rxauto.sh provision
```

Creates: CloudBees folder → credential + SSH node for **every** account in `accounts:` **and**
`setup.account`. Writes `complete.yml` (the manifest, next to `bee` in the Cloudbees dir). Idempotent — existing creds/nodes
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
rxauto.sh run-setup                        # all phases (default): makefile -> general -> auto -> server
rxauto.sh run-setup general                # only one phase: makefile | general | auto | server | all
# or explicitly: rxauto.sh bee job run RX_AUTO/rx_setup -p PHASE=all   (folder = base_name)
# or click the job in the CloudBees UI
```

The job runs on the dedicated setup node, from `$RX_AUTO_ROOT` (where
`my_ride_setup` / `my_cmd` / `my_cmd_for_common` and the Makefile live):
```
bs ... tcsh -f -c 'cd $RX_AUTO_ROOT; source my_ride_setup; source ./my_cmd; source ./my_cmd_for_common;
  <S4 Makefile mods on both RXEWS dirs>; <make general/auto/server targets>'
```
The `PHASE` build param (default `all`) selects which sub-step runs —
`makefile | general | auto | server | all`.

**Wait for this job to finish before running step 3** (`rxauto.sh all` does this
for you via `--wait`).

S4 changes applied automatically (both trunk IP and common IP dirs):
- `OS_TYPE_SETUP`: `"RHEL7"` → `"RHEL8"`
- `RDFS_ALTERNATIVE_CLOCK_GENERATION`: `0` → `1`
- `BS_PY3`, `BSIQ`, `BSBQ`: adds `-m "<DEDICATED_SV>"` to each `bs` command
- `GPUBASE`, `MASTER_LIST`, `MASTER_RTL`, `MASTER_BBOX`, `MASTER_RTL_*`: per-dir IP variants

### 5. Run step 3

**manual mode:**
```bash
rxauto.sh run              # triggers builds for all split files (round-robin across jobs)
rxauto.sh run --ip trunk   # trunk only
rxauto.sh run --ip all     # trunk AND common
```

`run.csh` scans `SUBMIT_LIST/NORMAL|COMMON/` under `$RX_AUTO_ROOT`, distributes split files
round-robin across jobs, and triggers one `bee job run` per file with `-p SPLIT_FILE=<path>`.
Each build runs (rx_run scripts live in `$RX_AUTO_ROOT/RX_AUTO/`):
```
bs ... tcsh -f -c "source $RX_AUTO_ROOT/my_ride_setup; bash $RX_AUTO_ROOT/RX_AUTO/<rx_run> $SPLIT_FILE"
```
CloudBees queues builds per node (executor=1) — nodes run in parallel, each node processes
its assigned files sequentially.

**auto mode:** no manual trigger — the `daily` job fires on schedule (e.g. every 30 min)
and runs `go_rx_auto` which detects SVN changes, queues, and runs everything.

```bash
rxauto.sh pause    # stop the schedule (job kept, just stops firing)
rxauto.sh resume   # restore schedule from config
```

---

## Re-run and maintenance

| Situation | Command |
|---|---|
| Everything, first run | `rxauto.sh all` (provision → deploy → rx_setup `--wait` → run) |
| Run step 3 again | `rxauto.sh run` |
| Environment changed (new SVN rev) | trigger `rx_setup` again, then `rxauto.sh run` |
| Switch trunk ↔ common (manual) | `rxauto.sh run --ip trunk\|common` (no redeploy needed) |
| Switch trunk ↔ common (auto) | edit `ip_mode:` in config, `rxauto.sh deploy` |
| Switch manual ↔ auto | edit `mode:` in config, `rxauto.sh deploy` (old jobs kept, schedule cleared) |
| Delete stale jobs/nodes/creds | `rxauto.sh prune --dry-run` then `rxauto.sh prune` |
| Teardown everything | `rxauto.sh manage teardown` |
| Check what exists | `rxauto.sh manage list` |

## After editing config.yaml — what to re-run

Match the section you changed to the command(s) that pick it up. When in doubt,
`provision` → `deploy` is always safe (both are idempotent).

| You edited | Re-run | Why |
|---|---|---|
| `accounts:` (add/remove/rename, or change password) | `rxauto.sh provision` then `rxauto.sh deploy` | provision makes the new cred+node; deploy makes that account's job |
| `node:` (`host`, `port`, `executors`, `remote_dir_base`) | `rxauto.sh provision` | node config is set at create time; re-provision updates it |
| `setup.account:` | `rxauto.sh provision` then `rxauto.sh deploy` | dedicated setup cred+node, then the `rx_setup` job |
| `mode:` (manual ↔ auto) | `rxauto.sh deploy` | old mode's jobs kept but schedule cleared; new mode's jobs created |
| `ip_mode:` (trunk/common/all) — **auto** | `rxauto.sh deploy` | changes which `daily_*` jobs + schedules exist |
| `ip_mode:` — **manual** | nothing; just `rxauto.sh run --ip <x>` | manual picks IP at run time, no redeploy |
| `bs:` (host_groups, os, mem, ride_setup) | `rxauto.sh deploy` | baked into each job's shell command |
| `manual.command` / `auto.command` / `auto.schedule` | `rxauto.sh deploy` | the job body/schedule is re-written |
| `setup.vars` / `setup.makefile_*` | `rxauto.sh deploy` then `rxauto.sh run-setup` | rebuilds the `rx_setup` job, then re-run step 1-2 |
| `base_name:` | `rxauto.sh provision` then `rxauto.sh deploy` | fresh namespace — creates a whole new folder/cred/node/job set (old one stays; `prune`/`teardown` to remove) |
| `controller:` | nothing in auto_env | select once by hand: `rxauto.sh bee controller select <name>` |

`provision` only creates what's missing (existing cred/node reused), and `deploy`
updates jobs in place, so re-running after a small edit is cheap and safe. Use
`prune` to delete infra the edited config no longer wants.

## Two modes

- **manual** — N accounts → N nodes → N jobs. `run.csh` calls `plan-splits` which round-robins
  split files across jobs; one `bee job run` per file with `-p SPLIT_FILE=<path>`. Each node has
  `executors=1` so its builds queue and process serially; nodes run in parallel. More accounts =
  more parallelism. `--ip all` triggers both trunk and common in one call.
- **auto** — 1 dedicated account → 1 node (executor=2 to allow trunk + common in parallel) → 1 or
  2 scheduled jobs (`daily_trunk`/`daily_common` when `ip_mode: all`) running `go_rx_auto`.

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
| `run.csh` | trigger step-3 builds (manual mode): calls `plan-splits` → round-robin → one `bee job run` per split file |
| `manage.csh` | `list` / `teardown` / `prune` from the manifest |
| `scripts/setup_all.bash` | manual alternative for step 1-2 (outside CloudBees) |
| `rxews_makefile/apply_makefile_mods.py` | applies S4 Makefile changes to both RXEWS dirs (backup, dry-run, idempotent) |
| `../complete.yml` | manifest (in the Cloudbees dir, next to `bee`): folder, cred-ids, node names, job names (written by provision/deploy) |
