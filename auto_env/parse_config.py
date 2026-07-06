#!/usr/bin/env python3
"""Brain of auto_env: parse config.yaml, emit action lines for csh,
and write the complete.yml manifest. csh is just glue calling bee - all text-heavy logic lives here.

Subcommands:
  plan-infra     <config.yaml>                          -> emit ACCT lines for provision.csh
  plan-jobs      <config.yaml>                          -> emit FOLDER/JOB lines for deploy.csh
  plan-run       <config.yaml>                          -> emit RUN lines for run.csh
  cred-pass      <config.yaml> <user>                   -> print one account's raw password
  get            <config.yaml> <dotted.key>             -> print one value (e.g. mode, base_name)
  write-manifest <config.yaml> <created.tsv> <out.yml>  -> write complete.yml
  merge-jobs     <manifest.yml> <created.jobs.tsv>      -> merge new jobs into manifest
  manifest-cred  <manifest.yml> <user>                  -> print stored cred-id for a user
  manifest-list  <manifest.yml> <jobs|nodes|credentials> -> print manifest entries

All output lines are TSV (\\t). csh reads them with `foreach line ("`...`")` + split.
"""
import sys, datetime
try:
    import yaml
except ImportError:
    sys.exit("parse_config.py: pyyaml required (pip install pyyaml)")


def load(path):
    with open(path) as f:
        return yaml.safe_load(f) or {}


def dig(d, dotted, default=None):
    cur = d
    for k in dotted.split("."):
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


def host_for(cfg):
    ip = cfg.get("ip_mode", "common")
    node = cfg.get("node", {})
    return node.get("host_trunk" if ip == "trunk" else "host_common", "")


def node_name(base, user):
    return f"{base}_{user}"




def emit(*fields):
    print("\t".join(str(f) for f in fields))


# -- accounts by mode ------------------------------------------------
def infra_accounts(cfg):
    """List of (username, password) needing cred+node, depending on mode.
    The dedicated setup account (setup.account) is appended when a setup: section exists,
    so provision builds its cred+node too (both modes)."""
    if cfg.get("mode") == "auto":
        a = dig(cfg, "auto.account", {})
        accts = [(a.get("username", ""), a.get("password", ""))]
    else:
        accts = [(a.get("username", ""), a.get("password", "")) for a in cfg.get("accounts", [])]
    s = dig(cfg, "setup.account", {})
    if s and s.get("username"):
        pair = (s.get("username", ""), s.get("password", ""))
        if pair not in accts:
            accts.append(pair)
    return accts


def cmd_plan_infra(cfg):
    """Emit one line per account, ONLY space-free fields (safe for csh word-split):
       ACCT<tab>user<tab>nodename<tab>host<tab>port<tab>remotedir<tab>executors
    Password fetched separately via `cred-pass` (printed raw, not word-split)."""
    base = cfg.get("base_name", "RX_AUTO")
    node = cfg.get("node", {})
    host = host_for(cfg)
    for user, _pw in infra_accounts(cfg):
        if not user:
            continue
        emit("ACCT", user, node_name(base, user), host, node.get("port", 22),
             f"{node.get('remote_dir_base', '/home').rstrip('/')}/{user}",
             node.get("executors", 1))


def cmd_cred_pass(cfg, user):
    """Print one account's raw password (no split, no quote) - provision reads it at cred-create time."""
    for u, pw in infra_accounts(cfg):
        if u == user:
            print(pw)
            return


def bs_env(cfg):
    """Env exports for the bs/LSF wrapper (from bs: block). Empty dict if no bs: section."""
    bs = cfg.get("bs") or {}
    if not bs:
        return {}
    return {
        "BS_GROUPS": bs.get("host_groups", ""),
        "BS_OS": bs.get("os", ""),
        "BS_MEM": str(bs.get("mem", "")),
        "RIDE_SETUP": bs.get("ride_setup", "my_ride_setup"),
    }


def shell_b64(command, rx_auto_root="", extra_env=None):
    """Wrap a bash command into a shell-safe one-word string (csh + escaping): base64-decode then run.
    Preserves multi-line scripts. Prepends RX_AUTO_ROOT + any extra_env as `export` lines.
    Build param IP_MODE reaches the agent via env -> bash reads it."""
    import base64
    lines = []
    if rx_auto_root:
        lines.append(f'export RX_AUTO_ROOT="{rx_auto_root}"')
    for k, v in (extra_env or {}).items():
        lines.append(f'export {k}="{v}"')
    prefix = ("\n".join(lines) + "\n") if lines else ""
    enc = base64.b64encode((prefix + (command or "")).encode()).decode()
    return f"echo {enc} | base64 -d | bash"


def cmd_plan_jobs(cfg):
    """Emit: FOLDER<tab>base ; JOB<tab>jobname<tab>folder<tab>node<tab>ip_mode<tab>schedule_b64|-<tab>shell_b64
    shell_b64 is one word (no spaces) -> safe for csh split. (manual needs no index: jobs claim at runtime)"""
    base = cfg.get("base_name", "RX_AUTO")
    ip = cfg.get("ip_mode", "common")
    root = cfg.get("rx_auto_root", "")
    import base64
    # schedule has spaces (cron) -> b64 into one word; deploy.csh decodes. "-" = no schedule.
    sched_enc = lambda s: base64.b64encode(s.encode()).decode() if s else "-"
    emit("FOLDER", base)
    if cfg.get("mode") == "auto":
        jn = dig(cfg, "auto.job_name", "daily")
        user = dig(cfg, "auto.account.username", "")
        sched = dig(cfg, "auto.schedule", "")
        emit("JOB", jn, base, node_name(base, user), ip, sched_enc(sched),
             shell_b64(dig(cfg, "auto.command", ""), root))
    else:
        # manual = work-stealing: each job claims split files at runtime (atomic mkdir).
        # No fixed index -> accounts > splits: extra workers idle; accounts < splits: keep claiming.
        # bs_env injects BS_GROUPS/BS_OS/BS_MEM/RIDE_SETUP so the command submits each file via LSF.
        prefix = dig(cfg, "manual.job_prefix", "job")
        cmd = dig(cfg, "manual.command", "")
        env = bs_env(cfg)
        for a in cfg.get("accounts", []):
            user = a.get("username", "")
            emit("JOB", f"{prefix}_{user}", base, node_name(base, user), ip, "-",
                 shell_b64(cmd, root, env))


def _load_setup_vars(cfg_path):
    """Read setup_vars from rxews_makefile/setup.yaml (next to config.yaml's dir). Empty if missing."""
    import os
    d = os.path.dirname(os.path.abspath(cfg_path))
    sy = os.path.join(d, "rxews_makefile", "setup.yaml")
    try:
        return load(sy).get("setup_vars", {}) or {}
    except FileNotFoundError:
        return {}


def _setup_bash_inner(cfg, cfg_path):
    """The bash-level part of step 1-2 (runs AFTER RiDE + my_cmd sourced in tcsh):
       Makefile common changes (S4) on both env dirs -> step-2 make targets.
    Kept quote-free of single quotes at the tcsh layer by b64-encoding this whole blob."""
    sv = _load_setup_vars(cfg_path)
    root = cfg.get("rx_auto_root", "") or sv.get("RX_AUTO_ROOT", "")
    crt = sv.get("COMMON_RUN_TYPE", "Trunk")
    ti = sv.get("TRUNK_IP_RXEWS_RUN_DIR_PATH", "")
    co = sv.get("COMMON_RXEWS_RUN_DIR_PATH", "")
    tib = sv.get("TRUNK_IP_ENV_BASE", "")
    cob = sv.get("COMMON_ENV_BASE", "")
    ddb = sv.get("DASHBOARD_DB_LOCATION", "")
    rev = sv.get("RIDE_ENV_VER", "")
    lines = [f'cd "{root}"']
    # -- Makefile common changes (S4 common) on both env dirs --
    for d in (ti, co):
        if d:
            lines.append(f'sed -i \'s/^\\([ \\t]*OS_TYPE_SETUP[ \\t]*=\\).*/\\1 "RHEL8"/\' "{d}/Makefile"')
            lines.append(f'sed -i \'s/^\\([ \\t]*RDFS_ALTERNATIVE_CLOCK_GENERATION[ \\t]*=\\).*/\\1 1/\' "{d}/makefile.vars"')
    # -- step 2: general_setup + auto_setup + server_setup make targets --
    lines += [
        f'make setup_run_cmd RX_AUTO_ROOT="{root}" RXEWS_RUN_DIR_PATH="{ti}"',
        f'make setup_run_cmd RX_AUTO_ROOT="{root}" RXEWS_RUN_DIR_PATH="{co}" RUN_TYPE="{crt}"',
        f'make setup_check_rp_cmd RX_AUTO_ROOT="{root}"',
        f'make setup_for_auto RX_AUTO_ROOT="{root}" RXEWS_RUN_DIR_PATH="{ti}"',
        f'make setup_for_auto RX_AUTO_ROOT="{root}" RXEWS_RUN_DIR_PATH="{co}" RUN_TYPE="{crt}"',
        f'make gen_dashboard_sv_core RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" ENV_BASE="{tib}" RIDE_ENV_VER="{rev}"',
        f'make gen_dashboard_sv_core RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" ENV_BASE="{cob}" RIDE_ENV_VER="{rev}" RUN_TYPE="{crt}"',
        f'make gen_ticket_panel_sv_core RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" TRUNK_IP_ENV_PATH="{tib}" COMMON_IP_ENV_PATH="{cob}"',
        f'make gen_update_dashboard_script RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" ENV_BASE="{tib}"',
        f'make gen_update_dashboard_script RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" ENV_BASE="{cob}" RUN_TYPE="{crt}"',
        f'make setup_dashboard_sv RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}"',
    ]
    return "\n".join(lines)


def cmd_plan_setup(cfg, cfg_path):
    """Emit one JOB line for the rx_setup job (no schedule, no IP_MODE).

    Layering (each layer quote-safe for the next):
      bee --shell:  echo <OUTER_b64> | base64 -d | bash
      bash runs:    bs -m "..." -I -os "..." -M "..." tcsh -f -c 'cd ROOT; source ride;
                      source ./my_cmd; source ./my_cmd_for_common; echo <INNER_b64> | base64 -d | bash'
      tcsh runs:    csh `source`s (RiDE + my_cmd populate RXEWS) then base64-decodes the bash inner
      bash inner:   Makefile common mods + step-2 make targets

    The tcsh -c arg is single-quoted and contains ONLY source cmds + base64 chars (no single quotes),
    so nothing clashes. INNER holds all the double/single quotes safely inside base64."""
    import base64
    setup = cfg.get("setup")
    if not setup:
        return
    base = cfg.get("base_name", "RX_AUTO")
    jn = setup.get("job_name", "rx_setup")
    user = dig(cfg, "setup.account.username", "")
    bs = cfg.get("bs") or {}
    root = cfg.get("rx_auto_root", "") or _load_setup_vars(cfg_path).get("RX_AUTO_ROOT", "")
    ride = bs.get("ride_setup", "my_ride_setup")

    inner_b64 = base64.b64encode(_setup_bash_inner(cfg, cfg_path).encode()).decode()
    tcsh_arg = (f'cd {root}; source {root}/{ride}; source ./my_cmd; source ./my_cmd_for_common; '
                f'echo {inner_b64} | base64 -d | bash')
    outer = (f'bs -m "{bs.get("host_groups","")}" -I -os "{bs.get("os","")}" '
             f'-M "{bs.get("mem","")}" tcsh -f -c \'{tcsh_arg}\'')
    emit("JOB", jn, base, node_name(base, user), "-", "-", shell_b64(outer))


def cmd_plan_run(cfg):
    """Emit RUN lines for manual (auto jobs run via schedule, no manual run).
    RUN<tab>jobname<tab>ip_mode<tab>wait(0|1)"""
    if cfg.get("mode") == "auto":
        return  # auto: Jenkins runs it on schedule
    base = cfg.get("base_name", "RX_AUTO")
    ip = cfg.get("ip_mode", "common")
    prefix = dig(cfg, "manual.job_prefix", "job")
    wait = "1" if dig(cfg, "manual.wait", False) else "0"
    for a in cfg.get("accounts", []):
        user = a.get("username", "")
        emit("RUN", f"{prefix}_{user}", ip, wait)


def cmd_write_manifest(cfg, created_tsv, out):
    """created.tsv: lines successfully created by provision/deploy, in the form:
       cred<tab>user<tab>cred_id | node<tab>name | folder<tab>name | job<tab>name
    Collected into complete.yml for reuse / teardown."""
    creds, nodes, folders, jobs = [], [], [], []
    try:
        with open(created_tsv) as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 2:
                    continue
                kind = parts[0]
                if kind == "cred" and len(parts) >= 3:
                    creds.append({"username": parts[1], "cred_id": parts[2]})
                elif kind == "node":
                    nodes.append(parts[1])
                elif kind == "folder":
                    folders.append(parts[1])
                elif kind == "job":
                    jobs.append(parts[1])
    except FileNotFoundError:
        pass
    manifest = {
        "base_name": cfg.get("base_name", "RX_AUTO"),
        "mode": cfg.get("mode", "manual"),
        "ip_mode": cfg.get("ip_mode", "common"),
        "created_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "folder": folders[0] if folders else cfg.get("base_name", "RX_AUTO"),
        "credentials": creds,
        "nodes": nodes,
        "jobs": jobs,
    }
    with open(out, "w") as f:
        yaml.safe_dump(manifest, f, sort_keys=False, allow_unicode=True)
    print(f"wrote {out}: {len(creds)} cred, {len(nodes)} node, {len(jobs)} job")


def cmd_manifest_cred(manifest_path, user):
    """Print the stored cred_id for a user (empty if none) - lets provision reuse the cred."""
    try:
        m = load(manifest_path)
    except FileNotFoundError:
        return
    for c in (m.get("credentials") or []):
        if c.get("username") == user:
            print(c.get("cred_id", ""))
            return


def cmd_manifest_list(manifest_path, kind):
    """Print each manifest entry of jobs/nodes/credentials(cred_id), one per line."""
    try:
        m = load(manifest_path)
    except FileNotFoundError:
        return
    if kind == "credentials":
        for c in (m.get("credentials") or []):
            print(c.get("cred_id", ""))
    else:
        for x in (m.get(kind) or []):
            print(x)


def cmd_merge_jobs(manifest_path, created_tsv):
    """Merge the new job list (created.jobs.tsv: job<tab>name) into the manifest, keeping cred/node."""
    try:
        m = load(manifest_path)
    except FileNotFoundError:
        m = {}
    jobs = list(m.get("jobs") or [])
    try:
        with open(created_tsv) as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) >= 2 and p[0] == "job" and p[1] not in jobs:
                    jobs.append(p[1])
    except FileNotFoundError:
        pass
    m["jobs"] = jobs
    with open(manifest_path, "w") as f:
        yaml.safe_dump(m, f, sort_keys=False, allow_unicode=True)
    print(f"manifest: {len(jobs)} job")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sub = sys.argv[1]
    # Subcommands that read the manifest (not config).
    if sub == "manifest-cred":
        cmd_manifest_cred(sys.argv[2], sys.argv[3]); return
    if sub == "manifest-list":
        cmd_manifest_list(sys.argv[2], sys.argv[3]); return
    if sub == "merge-jobs":
        cmd_merge_jobs(sys.argv[2], sys.argv[3]); return
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cfg_path = sys.argv[2]
    cfg = load(cfg_path)
    if sub == "plan-infra":
        cmd_plan_infra(cfg)
    elif sub == "cred-pass":
        cmd_cred_pass(cfg, sys.argv[3])
    elif sub == "plan-jobs":
        cmd_plan_jobs(cfg)
    elif sub == "plan-setup":
        cmd_plan_setup(cfg, cfg_path)
    elif sub == "plan-run":
        cmd_plan_run(cfg)
    elif sub == "get":
        print(dig(cfg, sys.argv[3], "") if len(sys.argv) > 3 else "")
    elif sub == "write-manifest":
        cmd_write_manifest(cfg, sys.argv[3], sys.argv[4])
    else:
        sys.exit(f"unknown subcommand: {sub}")


if __name__ == "__main__":
    main()
