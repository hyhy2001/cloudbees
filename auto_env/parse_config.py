#!/usr/bin/env python3
"""Brain of auto_env: parse config.yaml, emit action lines for csh,
and write the complete.yml manifest. csh is just glue calling bee - all text-heavy logic lives here.

Subcommands:
  plan-infra     <config.yaml>                          -> emit ACCT lines for provision.csh
  plan-jobs      <config.yaml>                          -> emit FOLDER/JOB lines for deploy.csh
  plan-run       <config.yaml>                          -> emit RUN lines for run.csh
  plan-splits    <config.yaml> <rx_auto_root> <ip>      -> emit SPLIT lines (round-robin split files -> jobs)
  plan-prune     <config.yaml> <manifest.yml>           -> emit PRUNE_* lines (destructive: manage prune)
  plan-stale-jobs <config.yaml> <manifest.yml>          -> emit STALE_JOB lines (deploy clears their schedule)
  prune-manifest <config.yaml> <manifest.yml>           -> drop pruned entries from complete.yml
  eff-mode/eff-ip <config.yaml>                         -> mode/ip with RXAUTO_MODE/RXAUTO_IP env override
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


def dump_yaml(data, f):
    """yaml.safe_dump with sort_keys=False, but tolerate PyYAML < 5.1.

    sort_keys was only added in PyYAML 5.1 (2019); older versions on some hosts
    raise 'dump_all() got an unexpected keyword argument sort_keys'. Fall back to
    a plain safe_dump there (key order not preserved, but the manifest still writes).
    """
    try:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
    except TypeError:
        yaml.safe_dump(data, f, default_flow_style=False, allow_unicode=True)


def dig(d, dotted, default=None):
    cur = d
    for k in dotted.split("."):
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


import os


def eff_mode(cfg):
    """mode with RXAUTO_MODE env override (manual|auto)."""
    return os.environ.get("RXAUTO_MODE") or cfg.get("mode", "manual")


def eff_ip(cfg):
    """ip_mode with RXAUTO_IP env override (common|trunk|all)."""
    return os.environ.get("RXAUTO_IP") or cfg.get("ip_mode", "common")


def ip_list(cfg):
    """Concrete IPs to act on: all -> [trunk, common], else the single one."""
    ip = eff_ip(cfg)
    return ["trunk", "common"] if ip == "all" else [ip]


def host_for(cfg):
    return cfg.get("node", {}).get("host", "")


def node_name(base, user):
    return f"{base}_{user}"




def emit(*fields):
    print("\t".join(str(f) for f in fields))


def _check_no_space(cfg):
    """csh reads our TSV lines with `foreach`/`set f = ($line)`, which word-splits on ANY
    whitespace - so fields that land in a space-split position MUST be space-free. Validate the
    config-derived names up front and fail with a clear message instead of silently mis-parsing."""
    checks = [
        ("base_name", cfg.get("base_name", "RX_AUTO")),
        ("manual.job_prefix", dig(cfg, "manual.job_prefix", "job")),
        ("auto.job_name", dig(cfg, "auto.job_name", "")),
        ("setup.job_name", dig(cfg, "setup.job_name", "")),
        ("node.remote_dir_base", dig(cfg, "node.remote_dir_base", "")),
        ("node.host", dig(cfg, "node.host", "")),
    ]
    for user, _ in infra_accounts(cfg):
        checks.append(("account username", user))
    bad = [f"{name}={val!r}" for name, val in checks if val and " " in str(val)]
    if bad:
        sys.exit("config error: these fields must not contain spaces (csh word-splits them):\n  "
                 + "\n  ".join(bad))


# -- accounts by mode ------------------------------------------------
def infra_accounts(cfg):
    """List of (username, password) needing cred+node, depending on mode.
    The dedicated setup account (setup.account) is appended when a setup: section exists,
    so provision builds its cred+node too (both modes)."""
    if eff_mode(cfg) == "auto":
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
    Password fetched separately via `cred-pass` (printed raw, not word-split).
    executors: auto.account and setup.account can override via their own `executors` field."""
    _check_no_space(cfg)
    base = cfg.get("base_name", "RX_AUTO")
    node = cfg.get("node", {})
    host = host_for(cfg)
    default_exec = node.get("executors", 1)
    root = _rx_auto_root(cfg)
    remote_base = f"{root}/cb_remote" if root else node.get("remote_dir_base", "/home")
    # build per-user executor overrides from special accounts
    exec_override = {}
    for key in ("auto.account", "setup.account"):
        a = dig(cfg, key, {}) or {}
        if a.get("username") and a.get("executors"):
            exec_override[a["username"]] = a["executors"]
    for user, _pw in infra_accounts(cfg):
        if not user:
            continue
        emit("ACCT", user, node_name(base, user), host, node.get("port", 22),
             f"{remote_base.rstrip('/')}/{user}",
             exec_override.get(user, default_exec))


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


def _dq(v):
    """Escape a value for inside a bash double-quoted string: \\ then " $ ` ."""
    v = str(v)
    for ch in ("\\", '"', "$", "`"):
        v = v.replace(ch, "\\" + ch)
    return v


def shell_b64(command, rx_auto_root="", extra_env=None):
    """Wrap a bash command into a shell-safe one-word string (csh + escaping): base64-decode then run.
    Preserves multi-line scripts. Prepends RX_AUTO_ROOT + any extra_env as `export` lines.
    Build param IP_MODE reaches the agent via env -> bash reads it."""
    import base64
    lines = []
    if rx_auto_root:
        lines.append(f'export RX_AUTO_ROOT="{_dq(rx_auto_root)}"')
    for k, v in (extra_env or {}).items():
        lines.append(f'export {k}="{_dq(v)}"')
    prefix = ("\n".join(lines) + "\n") if lines else ""
    enc = base64.b64encode((prefix + (command or "")).encode()).decode()
    return f"echo {enc} | base64 -d | bash"


def cmd_plan_jobs(cfg):
    """Emit: FOLDER<tab>base ; JOB<tab>jobname<tab>folder<tab>node<tab>ip_mode<tab>schedule_b64|-<tab>shell_b64
    shell_b64 is one word (no spaces) -> safe for csh split. (manual needs no index: jobs claim at runtime)"""
    _check_no_space(cfg)
    base = cfg.get("base_name", "RX_AUTO")
    ips = ip_list(cfg)
    root = cfg.get("rx_auto_root", "")
    import base64
    # schedule has spaces (cron) -> b64 into one word; deploy.csh decodes. "-" = no schedule.
    sched_enc = lambda s: base64.b64encode(s.encode()).decode() if s else "-"
    emit("FOLDER", base)
    if eff_mode(cfg) == "auto":
        # ip=all -> one scheduled job per ip (daily_trunk + daily_common); single ip keeps the plain name.
        jn0 = dig(cfg, "auto.job_name", "daily")
        user = dig(cfg, "auto.account.username", "")
        sched = dig(cfg, "auto.schedule", "")
        if not (dig(cfg, "auto.command", "") or "").strip():
            sys.exit("plan-jobs: auto.command is empty -> job would run an empty script. Set it in config.yaml.")
        for ip in ips:
            jn = f"{jn0}_{ip}" if len(ips) > 1 else jn0
            emit("JOB", jn, base, node_name(base, user), ip, sched_enc(sched),
                 shell_b64(dig(cfg, "auto.command", ""), root))
    else:
        # manual = work-stealing: each job claims split files at runtime (atomic mkdir).
        # No fixed index -> accounts > splits: extra workers idle; accounts < splits: keep claiming.
        # bs_env injects BS_GROUPS/BS_OS/BS_MEM/RIDE_SETUP so the command submits each file via LSF.
        prefix = dig(cfg, "manual.job_prefix", "job")
        cmd = dig(cfg, "manual.command", "")
        if not (cmd or "").strip():
            sys.exit("plan-jobs: manual.command is empty -> job would run an empty script. Set it in config.yaml.")
        env = bs_env(cfg)
        parent = _rx_parent(cfg)
        if parent:
            env["RX_AUTO_PARENT"] = parent
        if root:
            env["CB_RUN_DIR"] = f"{root}/cb_run"
        # manual: IP_MODE must be DEFINED on the job (default = first ip) so run.csh can
        # override it per-ip with -p IP_MODE=... at runtime. ip=all -> default trunk, run does both.
        ip_def = ips[0]
        for a in cfg.get("accounts", []):
            user = a.get("username", "")
            emit("JOB", f"{prefix}_{user}", base, node_name(base, user), ip_def, "-",
                 shell_b64(cmd, root, env))


# -- S2 env-var derivation (guide S2) ---------------------------------------
# Each var is auto-derived from RX_AUTO_ROOT following OUR naming rule, but a
# non-empty user value in config always wins. RX_AUTO_ROOT itself: config
# rx_auto_root > env RXAUTO_ROOT (exported by rxauto.sh from where it's invoked).
# ENV_BASE vars stay EMPTY here on purpose: the real RxEnv-* dir carries a dynamic
# SVN ${REV} (guide S4) so it's globbed at runtime by the bash that consumes it.
# LOCAL_PYTHON/LOCAL_PYTHON_BIN/UPDATE_DB_SCHEDULES/USER_CUSTOM_SRC: user-fillable, no default.

def _rx_auto_root(cfg):
    """RX_AUTO_ROOT: user override (config rx_auto_root) else env RXAUTO_ROOT (rxauto.sh)."""
    return (cfg.get("rx_auto_root") or "").strip() or os.environ.get("RXAUTO_ROOT", "").strip()


def _rx_parent(cfg):
    """RX_AUTO_PARENT: dir holding rxauto.sh/config.yaml + the shell-init files
    (my_ride_setup, my_cmd, my_cmd_for_common). Config override > env RXAUTO_PARENT
    (rxauto.sh) > RX_AUTO_ROOT's parent as a last resort."""
    v = (cfg.get("rx_auto_parent") or "").strip() or os.environ.get("RXAUTO_PARENT", "").strip()
    if v:
        return v
    root = _rx_auto_root(cfg)
    return os.path.dirname(root) if root else ""


def _load_setup_vars(cfg):
    """S2 env vars: start from setup.vars, then fill any empty one with its derived default.
    User-set (non-empty) values are never overwritten."""
    sv = dict(dig(cfg, "setup.vars", {}) or {})
    root = _rx_auto_root(cfg)
    defaults = {
        "RX_AUTO_ROOT": root,
        "TRUNK_IP_RXEWS_RUN_DIR_PATH": f"{root}/rxews_trunk_ip_vnet_" if root else "",
        "COMMON_RXEWS_RUN_DIR_PATH": f"{root}/rxews_trunk_vnet_wk_" if root else "",
        "DEDICATED_SV": "HOSTGR_L HOSTGR_M HOSTGR_S HOSTGR_621910",
        "RIDE_ENV_VER": "WK18",
        "DASHBOARD_DB_LOCATION": f"{root}/dashboard_db" if root else "",
        "COMMON_RUN_TYPE": "Trunk",
    }
    for k, v in defaults.items():
        if str(sv.get(k, "")).strip() == "" and v:
            sv[k] = v
    return sv


def _sed_escape(s):
    r"""Escape for BRE sed replacement: \ first, then & and /."""
    return s.replace("\\", r"\\").replace("&", r"\&").replace("/", r"\/")


def _sed_change(env_dir, ch):
    """One idempotent sed line for a makefile change entry. Skip empty new.
    - var present: replace RHS of `[export] VAR [?:]= ...`
    - old present (no var): literal string replace (for eval/macro lines)."""
    new, fname = str(ch.get("new", "")), ch.get("file", "")
    if new.strip() == "" or not fname:
        return None
    var = ch.get("var", "")
    old = ch.get("old", "")
    path = f'"{env_dir}/{fname}"'
    if var:
        esc = _sed_escape(new)
        pat = f'^\\([ \\t]*\\(export[ \\t]\\+\\)\\?{var}[ \\t]*[?:]*=\\)'
        return f'sed -i \'s/{pat}.*/\\1 {esc}/\' {path}'
    if old:
        esc_old = _sed_escape(old)
        esc_new = _sed_escape(new)
        return f'sed -i \'s/{esc_old}/{esc_new}/\' {path}'
    return None


def _envbase_resolve_bash(var, user_val, rxews_dir, prefix):
    """Emit bash that sets $var to the ENV_BASE path.
    User value wins; else read REV from the dir's Makefile and build the path deterministically."""
    if str(user_val).strip():
        return f'{var}="{_dq(user_val)}"'
    rev_var = f'_REV_{var}'
    return (
        f'{rev_var}=$(grep -m1 "^[[:space:]]*REV[[:space:]]*[?:]*=" "{rxews_dir}/Makefile" '
        f'| sed "s/.*=[[:space:]]*//" | tr -d " \\t"); '
        f'[ -n "${{{rev_var}}}" ] || {{ echo "setup: REV not found in {rxews_dir}/Makefile" >&2; exit 1; }}; '
        f'{var}="{rxews_dir}/{prefix}-${{{rev_var}}}"'
    )


def _setup_bash_inner(cfg):
    """The bash-level part of step 1-2 (runs AFTER RiDE + my_cmd sourced in tcsh):
       Makefile common changes (S4) on both env dirs -> step-2 make targets.
    Kept quote-free of single quotes at the tcsh layer by b64-encoding this whole blob."""
    sv = _load_setup_vars(cfg)
    root = sv.get("RX_AUTO_ROOT", "")
    crt = sv.get("COMMON_RUN_TYPE", "Trunk")
    ti = sv.get("TRUNK_IP_RXEWS_RUN_DIR_PATH", "")
    co = sv.get("COMMON_RXEWS_RUN_DIR_PATH", "")
    tib = sv.get("TRUNK_IP_ENV_BASE", "")
    cob = sv.get("COMMON_ENV_BASE", "")
    ddb = sv.get("DASHBOARD_DB_LOCATION", "")
    rev = sv.get("RIDE_ENV_VER", "")
    dsv = sv.get("DEDICATED_SV", "")
    changes = cfg.get("setup", {}).get("makefile_common_changes") or []
    trunk_ip_chg = cfg.get("setup", {}).get("makefile_trunk_ip_changes") or []
    common_ip_chg = cfg.get("setup", {}).get("makefile_common_ip_changes") or []
    # BS_PY3/BSIQ/BSBQ: inject -m "DEDICATED_SV" after the bs flag, applied to both dirs.
    bs_changes = []
    if dsv:
        for var, flag in (("BS_PY3", "-I"), ("BSIQ", "-K"), ("BSBQ", "-B")):
            bs_changes.append({"file": "Makefile",
                                "old": f"bs {flag} -os ${{OS_TYPE_SETUP}}",
                                "new": f'bs {flag} -os ${{OS_TYPE_SETUP}} -m "{dsv}"'})
    lines = [f'cd "{root}"']
    # -- S4 Makefile changes: common (both dirs) + per-dir-only changes + BS changes --
    for d, extra in ((ti, trunk_ip_chg), (co, common_ip_chg)):
        if not d:
            continue
        for ch in changes + bs_changes + extra:
            sed = _sed_change(d, ch)
            if sed:
                lines.append(sed)
    # -- ENV_BASE: user value wins; else glob the RxEnv-* dir my_cmd created (dynamic ${REV}). --
    lines.append(_envbase_resolve_bash("TIB", tib, ti, "RxEnv-Trunk-IP-VNET"))
    lines.append(_envbase_resolve_bash("COB", cob, co, "RxEnv-Trunk-VNET"))
    # -- step 2: general_setup + auto_setup + server_setup make targets --
    lines += [
        f'make setup_run_cmd RX_AUTO_ROOT="{root}" RXEWS_RUN_DIR_PATH="{ti}"',
        f'make setup_run_cmd RX_AUTO_ROOT="{root}" RXEWS_RUN_DIR_PATH="{co}" RUN_TYPE="{crt}"',
        f'make setup_check_rp_cmd RX_AUTO_ROOT="{root}"',
        f'make setup_for_auto RX_AUTO_ROOT="{root}" RXEWS_RUN_DIR_PATH="{ti}"',
        f'make setup_for_auto RX_AUTO_ROOT="{root}" RXEWS_RUN_DIR_PATH="{co}" RUN_TYPE="{crt}"',
        f'make gen_dashboard_sv_core RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" ENV_BASE="$TIB" RIDE_ENV_VER="{rev}"',
        f'make gen_dashboard_sv_core RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" ENV_BASE="$COB" RIDE_ENV_VER="{rev}" RUN_TYPE="{crt}"',
        f'make gen_ticket_panel_sv_core RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" TRUNK_IP_ENV_PATH="$TIB" COMMON_IP_ENV_PATH="$COB"',
        f'make gen_update_dashboard_script RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" ENV_BASE="$TIB"',
        f'make gen_update_dashboard_script RX_AUTO_ROOT="{root}" DASHBOARD_DB_LOCATION="{ddb}" ENV_BASE="$COB" RUN_TYPE="{crt}"',
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
    root = _load_setup_vars(cfg).get("RX_AUTO_ROOT", "")
    parent = _rx_parent(cfg)
    ride = bs.get("ride_setup", "my_ride_setup")

    # my_ride_setup, my_cmd, my_cmd_for_common all live in the PARENT dir (next to
    # rxauto.sh), not in RX_AUTO/. cd there to source them, then the inner bash
    # (which cd's to RX_AUTO_ROOT itself) runs the make targets.
    inner_b64 = base64.b64encode(_setup_bash_inner(cfg).encode()).decode()
    tcsh_arg = (f'cd {parent}; source {parent}/{ride}; source ./my_cmd; source ./my_cmd_for_common; '
                f'echo {inner_b64} | base64 -d | bash')
    outer = (f'bs -m "{bs.get("host_groups","")}" -I -os "{bs.get("os","")}" '
             f'-M "{bs.get("mem","")}" tcsh -f -c \'{tcsh_arg}\'')
    emit("JOB", jn, base, node_name(base, user), "-", "-", shell_b64(outer))


def cmd_plan_splits(cfg, rx_auto_root, ip):
    """Emit SPLIT<tab>jobname<tab>split_file lines, round-robin across jobs.
    rx_auto_root: path to RX_AUTO package root (so we can glob SUBMIT_LIST).
    ip: trunk|common (single value, not all)."""
    base = cfg.get("base_name", "RX_AUTO")
    prefix = dig(cfg, "manual.job_prefix", "job")
    jobs = [f"{prefix}_{a['username']}" for a in cfg.get("accounts", []) if a.get("username")]
    if not jobs:
        sys.exit("plan-splits: no accounts configured")
    # rx_auto_root already points at the RX_AUTO dir (holds rx_run + SUBMIT_LIST),
    # so do NOT append another "RX_AUTO" segment.
    if ip == "trunk":
        pat = os.path.join(rx_auto_root, "SUBMIT_LIST", "NORMAL", "normal_submit_module_list_*")
    else:
        pat = os.path.join(rx_auto_root, "SUBMIT_LIST", "COMMON", "common_submit_module_list_*")
    import glob as _glob
    files = sorted(_glob.glob(pat))
    if not files:
        sys.exit(f"plan-splits: no split files found at {pat}")
    for i, f in enumerate(files):
        emit("SPLIT", jobs[i % len(jobs)], f)


def cmd_plan_run(cfg):
    """Emit RUN lines for manual (auto jobs run via schedule, no manual run).
    RUN<tab>jobname<tab>ip_mode<tab>wait(0|1). ip=all -> one RUN per account per ip (trunk+common)."""
    if eff_mode(cfg) == "auto":
        return  # auto: Jenkins runs it on schedule
    base = cfg.get("base_name", "RX_AUTO")
    prefix = dig(cfg, "manual.job_prefix", "job")
    wait = "1" if dig(cfg, "manual.wait", False) else "0"
    for a in cfg.get("accounts", []):
        user = a.get("username", "")
        for ip in ip_list(cfg):
            emit("RUN", f"{prefix}_{user}", ip, wait)


def _desired_sets(cfg):
    """What the CURRENT config wants to exist: (jobs {folder/name}, nodes, cred usernames).
    Used by prune to find stale manifest entries after a mode/account change."""
    base = cfg.get("base_name", "RX_AUTO")
    users = [u for u, _ in infra_accounts(cfg) if u]
    nodes = {node_name(base, u) for u in users}
    ips = ip_list(cfg)
    jobs = set()
    if eff_mode(cfg) == "auto":
        jn0 = dig(cfg, "auto.job_name", "daily")
        for ip in ips:
            jobs.add(f"{base}/{jn0}_{ip}" if len(ips) > 1 else f"{base}/{jn0}")
    else:
        prefix = dig(cfg, "manual.job_prefix", "job")
        for a in cfg.get("accounts", []):
            if a.get("username"):
                jobs.add(f"{base}/{prefix}_{a['username']}")
    if cfg.get("setup"):
        jobs.add(f"{base}/{dig(cfg, 'setup.job_name', 'rx_setup')}")
    return jobs, nodes, set(users)


def cmd_plan_stale_jobs(cfg, manifest_path):
    """Emit STALE_JOB <folder/job> for manifest jobs the current plan no longer includes.
    deploy.csh clears their schedule (bee job update --schedule '') to KEEP the job but disable
    its timer - e.g. auto->manual leaves daily_* around but stops it firing. Non-destructive."""
    try:
        m = load(manifest_path)
    except FileNotFoundError:
        return
    want_jobs, _, _ = _desired_sets(cfg)
    for j in (m.get("jobs") or []):
        if j not in want_jobs:
            emit("STALE_JOB", j)


def cmd_plan_prune(cfg, manifest_path):
    """Emit delete lines for manifest entries the current config no longer wants:
       PRUNE_JOB <folder/job> | PRUNE_NODE <node> | PRUNE_CRED <cred-id>
    (folder is never pruned). deploy.csh runs these via bee, then calls prune-manifest."""
    try:
        m = load(manifest_path)
    except FileNotFoundError:
        return
    want_jobs, want_nodes, want_users = _desired_sets(cfg)
    for j in (m.get("jobs") or []):
        if j not in want_jobs:
            emit("PRUNE_JOB", j)
    for n in (m.get("nodes") or []):
        if n not in want_nodes:
            emit("PRUNE_NODE", n)
    for c in (m.get("credentials") or []):
        if c.get("username") not in want_users:
            emit("PRUNE_CRED", c.get("cred_id", ""))


def cmd_prune_manifest(cfg, manifest_path):
    """Rewrite the manifest keeping only entries the current config still wants (drop pruned)."""
    try:
        m = load(manifest_path)
    except FileNotFoundError:
        return
    want_jobs, want_nodes, want_users = _desired_sets(cfg)
    m["jobs"] = [j for j in (m.get("jobs") or []) if j in want_jobs]
    m["nodes"] = [n for n in (m.get("nodes") or []) if n in want_nodes]
    m["credentials"] = [c for c in (m.get("credentials") or []) if c.get("username") in want_users]
    with open(manifest_path, "w") as f:
        dump_yaml(m, f)
    print(f"manifest pruned: {len(m['credentials'])} cred, {len(m['nodes'])} node, {len(m['jobs'])} job")


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
    # merge with existing manifest so switching mode (manual<->auto) keeps the OLD
    # cred/node/job entries around -> deploy's prune step can then delete the stale ones.
    try:
        old = load(out)
    except FileNotFoundError:
        old = {}
    cred_map = {c.get("username"): c for c in (old.get("credentials") or [])}
    for c in creds:
        cred_map[c["username"]] = c   # new cred-id wins for an existing user
    merged_nodes = list(dict.fromkeys((old.get("nodes") or []) + nodes))
    merged_jobs = list(dict.fromkeys((old.get("jobs") or []) + jobs))
    manifest = {
        "base_name": cfg.get("base_name", "RX_AUTO"),
        "mode": cfg.get("mode", "manual"),
        "ip_mode": cfg.get("ip_mode", "common"),
        "created_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "folder": folders[0] if folders else cfg.get("base_name", "RX_AUTO"),
        "credentials": list(cred_map.values()),
        "nodes": merged_nodes,
        "jobs": merged_jobs,
    }
    with open(out, "w") as f:
        dump_yaml(manifest, f)
    print(f"wrote {out}: {len(manifest['credentials'])} cred, {len(merged_nodes)} node, {len(merged_jobs)} job")


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
        dump_yaml(m, f)
    print(f"manifest: {len(jobs)} job")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sub = sys.argv[1]
    def need(n):
        # total argv count required; clear error instead of IndexError.
        if len(sys.argv) < n:
            sys.exit(f"{sub}: expected {n - 2} argument(s), got {max(0, len(sys.argv) - 2)}")
    # Subcommands that read the manifest (not config).
    if sub == "manifest-cred":
        need(4); cmd_manifest_cred(sys.argv[2], sys.argv[3]); return
    if sub == "manifest-list":
        need(4); cmd_manifest_list(sys.argv[2], sys.argv[3]); return
    if sub == "merge-jobs":
        need(4); cmd_merge_jobs(sys.argv[2], sys.argv[3]); return
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cfg_path = sys.argv[2]
    cfg = load(cfg_path)
    if sub == "plan-infra":
        cmd_plan_infra(cfg)
    elif sub == "cred-pass":
        need(4); cmd_cred_pass(cfg, sys.argv[3])
    elif sub == "plan-jobs":
        cmd_plan_jobs(cfg)
    elif sub == "plan-setup":
        cmd_plan_setup(cfg, cfg_path)
    elif sub == "plan-run":
        cmd_plan_run(cfg)
    elif sub == "plan-splits":
        # plan-splits <config.yaml> <rx_auto_root> <ip>
        need(5); cmd_plan_splits(cfg, sys.argv[3], sys.argv[4])
    elif sub == "plan-prune":
        need(4); cmd_plan_prune(cfg, sys.argv[3])
    elif sub == "plan-stale-jobs":
        need(4); cmd_plan_stale_jobs(cfg, sys.argv[3])
    elif sub == "prune-manifest":
        need(4); cmd_prune_manifest(cfg, sys.argv[3])
    elif sub == "eff-mode":
        print(eff_mode(cfg))
    elif sub == "eff-ip":
        print(eff_ip(cfg))
    elif sub == "get":
        print(dig(cfg, sys.argv[3], "") if len(sys.argv) > 3 else "")
    elif sub == "write-manifest":
        need(5); cmd_write_manifest(cfg, sys.argv[3], sys.argv[4])
    else:
        sys.exit(f"unknown subcommand: {sub}")


if __name__ == "__main__":
    main()
