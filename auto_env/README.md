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
   |  2) deploy.csh      create/update step-3 jobs (rx_run work-stealing / go_rx_auto)
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
rxauto.sh manage list          # -> auto_env/manage.csh
rxauto.sh setup all --dry-run  # -> auto_env/scripts/setup_all.bash
rxauto.sh all                  # provision -> deploy -> run
rxauto.sh bee <args...>        # raw bee passthrough
```

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

Switching common<->trunk for **manual** later: `bee job run -p IP_MODE=...` (build param, no redeploy).
For **auto**, IP_MODE is baked as the job default at create time -> to change it, re-run `deploy.csh`.

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
