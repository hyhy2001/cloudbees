# auto_env - CloudBees automation for RX AUTO

Embeds **CloudBees (`bee`)** as an orchestration layer over **RX AUTO** (another team's verification
environment, see `../../../guide.html`). A single operator (already `bee auth login` + `bee controller
select`) uses several **Linux accounts** (username+password) to build credentials + nodes + freestyle
jobs, each job running **RX AUTO step 3** on its node.

## Layout (guide S3)

```
RX_AUTO/
`--- UTLs/
    `--- Cloudbees/
        |--- bee              <- the bee binary
        `--- auto_env/    <- this package (sits next to bee)
            |--- config.yaml
            |--- parse_config.py
            |--- lib.csh  provision.csh  deploy.csh  run.csh  manage.csh
            |--- templates/job.sh
            |--- scripts/setup_all.bash
            `--- rxews_makefile/apply_makefile_mods.py
```

`lib.csh` resolves the binary as `../bee` (relative to auto_env). Override with env `BEE` for testing.

## The two run modes

- **manual** - N accounts -> N nodes -> N jobs, **work-stealing**. RX AUTO pre-splits the module list at
  setup into `SUBMIT_LIST/NORMAL|COMMON/.._00,_01,...`; N workers scan and each claims the next split
  file (atomic `mkdir`) until exhausted. accounts > splits -> extra workers idle; accounts < splits ->
  workers keep claiming. Requires `SUBMIT_LIST` shared across nodes. Each claimed file is submitted to
  LSF via `bs ... tcsh -f -c "source my_ride_setup; bash rx_run <file>"` (params from the `bs:` block).
- **auto** - 1 dedicated account -> 1 node -> 1 job running `go_rx_auto` (orchestrator) with `--schedule`
  (e.g. every 30 min).

`IP_MODE=trunk` -> `01_*` scripts; `IP_MODE=common` -> `02_*` scripts.

## RX AUTO step split (guide S13)

| Step | What | Where |
|---|---|---|
| 1-2 | prerequisites + setup (S4 Makefile mods, general/auto/server_setup) | **two options**: `scripts/setup_all.bash` (by hand, outside CloudBees) OR the `rx_setup` bee job (runs on a dedicated node) |
| 3 | `go_rx_auto` / `rx_run` | **bee job** (deploy.csh + run.csh) |
| 4 | monitoring/dashboard | not touched; `server_setup` only generates scripts, never starts them |

### Step 1-2 as a bee job (`rx_setup`)

`deploy.csh` also creates a `rx_setup` freestyle job (from the `setup:` block in config) on a
**dedicated account/node**. Triggering it runs the whole step 1-2 on that node as a single LSF
submit that sources RiDE first:

```
bs -m "<host_groups>" -I -os <os> -M <mem> tcsh -f -c 'cd ROOT; source my_ride_setup;
   source ./my_cmd; source ./my_cmd_for_common; <makefile common mods>; <step-2 makes>'
```

The `bs`/LSF params live in the `bs:` block; the RXEWS paths come from `setup.vars` (in `config.yaml`).
The step-2 body (Makefile mods + `make` targets) is base64-encoded so the sed/make
quotes never clash with the single-quoted `tcsh -c` argument. This is an alternative to
`setup_all.bash`, not a replacement - both exist.

## Flow

```
config.yaml  0) setup_all.bash    RX AUTO step 1-2 - OUTSIDE CloudBees, once
   |         (or the rx_setup bee job)
   |  1) provision.csh   folder -> cred + node   (built rarely; cred/node reused)
   |  2) deploy.csh      prune stale infra (mode switch) + create/update step-3 jobs
   |  3) run.csh         manual: bee job run -p IP_MODE=...   (auto: waits for schedule)
   `-- complete.yml       manifest: base_name, REAL cred-id (bee-generated), nodes, jobs
      manage.csh list|run|teardown   <- operate again from the manifest
```

## Run it

A single entry point `../rxauto.sh` (sits OUTSIDE auto_env, next to `bee`) auto-detects the
`RX_AUTO/UTLs/Cloudbees` dir and dispatches into this package:

```bash
rxauto.sh provision            # -> auto_env/provision.csh
rxauto.sh deploy               # -> auto_env/deploy.csh
rxauto.sh run                  # -> auto_env/run.csh
rxauto.sh manage list          # -> auto_env/manage.csh (list|run|teardown|prune)
rxauto.sh prune                # -> manage.csh prune (delete stale infra, opt-in)
rxauto.sh setup all --dry-run  # -> auto_env/scripts/setup_all.bash
rxauto.sh all                  # provision -> deploy -> run
rxauto.sh bee <args...>        # raw bee passthrough
```

Add `--mode manual|auto` / `--ip common|trunk|all` to any command to override config for that run.

It exports `BEE` from the detected dir. Override detection with `RXAUTO_CB=/path/to/.../Cloudbees`.
Or call the scripts directly:

```bash
# 0) RX AUTO step 1-2 (outside CloudBees, once) - edit config.yaml (setup: block) first
bash scripts/setup_all.bash all --dry-run   # preview make + S4 mods
bash scripts/setup_all.bash all             # run for real (or a single phase: makefile|general|auto|server)
```
```csh
csh provision.csh --dry-run   # preview, no network calls
csh provision.csh             # create folder + cred + node, write complete.yml
csh deploy.csh                # create/update jobs
csh run.csh                   # (manual) trigger each job with IP_MODE (jobs self-claim splits)
csh manage.csh list           # show what was created
csh manage.csh teardown       # delete job -> node -> cred -> folder
```

### Switch mode/ip without editing config: `--mode` / `--ip`

`rxauto.sh` takes `--mode manual|auto` and `--ip common|trunk|all` (anywhere in the args); they
override `mode`/`ip_mode` in config for that one command (via env `RXAUTO_MODE`/`RXAUTO_IP`).

```bash
rxauto.sh deploy --mode auto --ip all   # 2 scheduled jobs: daily_trunk + daily_common
rxauto.sh run --ip all                  # manual: run each build_* for BOTH trunk + common
rxauto.sh deploy --mode manual          # back to manual
```

`--ip all`: manual -> `run` fires each job for trunk AND common; auto -> deploy makes one scheduled
job per ip (`daily_trunk`, `daily_common`) since a scheduled job bakes a single IP_MODE.

### Switching manual<->auto keeps the other mode's jobs

`deploy` never deletes jobs. When you switch mode, the jobs of the OTHER mode become "stale" and
deploy just **clears their schedule** (`bee job update --schedule ''`) - the job stays on the
controller, only its timer stops. So auto->manual leaves `daily_*` around (idle), manual->auto
leaves `build_*` around. Flip back later and `deploy` re-attaches everything.

To actually DELETE what the current config no longer wants (jobs + their nodes/creds; folder and
`rx_setup` kept), run the opt-in destructive step:

```bash
rxauto.sh prune --dry-run   # preview deletes
rxauto.sh prune             # delete stale jobs/nodes/creds, rewrite the manifest
```

Switching common<->trunk within a mode: **manual** just needs `rxauto.sh run --ip ...` (IP_MODE is a
runtime param); **auto** bakes IP_MODE at create time, so re-run `rxauto.sh deploy --ip ...`.

## Step-by-step: setup -> provision -> deploy -> run (all 4 combos)

Two facts that make the combos simple:
- **setup (step 1-2) covers BOTH trunk + common at once** - it applies the Makefile mods to both env
  dirs and runs the `make` targets for both. It does NOT care about `ip_mode`; run it **once**.
- **only run (step 3) splits trunk vs common** via `IP_MODE`: `trunk` -> `01_*`, `common` -> `02_*`.

So step 0-1-2 are identical everywhere; only `mode`/`ip_mode` in config and the final trigger differ.

### Common to every combo - setup once

```bash
# prereq: bee auth login + controller selected; config.yaml has rx_auto_root,
#         setup.vars (2 RXEWS dirs + ENV_BASE + DASHBOARD_DB), bs: block
rxauto.sh setup all --dry-run   # preview
rxauto.sh setup all             # Makefile mods (both dirs) + make general/auto/server
```

### 1. manual + trunk

```yaml
mode: manual
ip_mode: trunk
accounts: [ user01, user02, ... ]   # N workers
```
```bash
rxauto.sh provision   # N cred + N node (RX_AUTO_userXX) + setup node
rxauto.sh deploy      # N job build_userXX + rx_setup
rxauto.sh run         # bee job run build_* -p IP_MODE=trunk
```
Each job claims `SUBMIT_LIST/NORMAL/normal_submit_module_list_*` (atomic mkdir), submits via
`bs ... tcsh -c "source ride; bash 01_rx_run_ip_unit.bash <file>"`.

### 2. manual + common

Same config as (1), just:
```yaml
ip_mode: common
```
```bash
rxauto.sh provision   # cred/node reused if already built
rxauto.sh deploy
rxauto.sh run         # -p IP_MODE=common
```
Claims `SUBMIT_LIST/COMMON/common_submit_module_list_*`, runs `02_rx_run_common_ip_unit.bash`.

> Switching trunk<->common for **manual**: IP_MODE is a build param -> just edit `ip_mode` and
> `rxauto.sh run` again. **No redeploy.**

### 3. auto + trunk

```yaml
mode: auto
ip_mode: trunk
auto:
  account: { username: user11, password: ... }
  job_name: daily
  schedule: "H/30 * * * *"
```
```bash
rxauto.sh provision   # 1 cred + 1 node for user11 (+ setup node)
rxauto.sh deploy      # job daily, --param-def IP_MODE=trunk, --schedule
# no run - the job fires on its schedule
```
Runs `cd RX_AUTO; ./01_go_rx_auto.bash` (orchestrator: detect -> queue -> run).

### 4. auto + common

Same as (3), just:
```yaml
ip_mode: common
```
```bash
rxauto.sh provision
rxauto.sh deploy      # IP_MODE=common baked as the job default
```
Runs `./02_go_rx_auto.bash` on schedule.

> Switching trunk<->common for **auto**: IP_MODE is baked as the job default at create time ->
> edit `ip_mode` and **`rxauto.sh deploy` again** (not just run).

### Summary

| combo | setup | provision | deploy | trigger |
|---|---|---|---|---|
| manual/trunk  | `setup all` | N cred+node | N `build_*` | `run` -> IP_MODE=trunk -> `01_rx_run` |
| manual/common | (already) | reused | update | `run` -> IP_MODE=common -> `02_rx_run` |
| auto/trunk    | `setup all` | 1 cred+node | `daily` + schedule | schedule -> `01_go_rx_auto` |
| auto/common   | (already) | reused | redeploy | schedule -> `02_go_rx_auto` |

Key: setup is shared (once, both IPs); trunk vs common only differs at run/schedule (`01_*` vs `02_*`);
manual changes IP with `run`, auto needs a `deploy`; changing **mode** = `deploy --mode ...` (keeps
the other mode's jobs, just clears their schedule; `rxauto.sh prune` deletes them if you want).

## Avoiding name clashes

Change `base_name` in config each round (e.g. `RX_AUTO` -> `RX_AUTO_v2`). Folder/node/job all use it as
prefix, so a new name means a fresh namespace that never overwrites the previous round.

## Environment notes (outside this package)

1. **`csh` must be installed** - not present on all hosts: `apt install tcsh`.
2. **SSH nodes via password** - if `host` is localhost and `sshd` has `PasswordAuthentication no`, the SSH
   agent won't connect -> node offline -> builds **PENDING**. Enable password auth on the target host or
   switch the node to an SSH key. `provision.csh` warns when host=localhost.
3. **YAML** - no `yq` needed; parsed with `python3` + `pyyaml`.

## Files

| File | Role |
|---|---|
| `config.yaml` | the input you edit (accounts, node, mode, `bs:` LSF params, `setup:` job) |
| `parse_config.py` | brain: parse YAML, render commands (incl. `plan-setup`), b64-encode, manifest |
| `lib.csh` | resolve bee (`../bee`), select controller |
| `provision.csh` | folder + cred (captures cred-id) + node |
| `deploy.csh` | create/update jobs (`--param-def IP_MODE`, `--schedule` for auto) |
| `run.csh` | trigger jobs (manual) |
| `manage.csh` | list / run-all / teardown from the manifest |
| `templates/job.sh` | default step-3 body sample (the config command is the real one) |
| `scripts/setup_all.bash` | merged step 1-2 (S6): `[all\|makefile\|general\|auto\|server]` |
| `rxews_makefile/apply_makefile_mods.py` | applies S4 common changes (from `config.yaml` `setup:`) to both env dirs (backup, dry-run, idempotent) |

> The config command is **base64-encoded** into `--shell` (the job runs `... | base64 -d | bash`) so a
> multi-line bash script survives csh intact. Build param `IP_MODE` reaches the agent via env.
