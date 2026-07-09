#!/usr/bin/env python3
"""Apply RXEWS Makefile modifications (guide S4, COMMON CHANGES ONLY) - prerequisite step 1.
Reads ../config.yaml: env dir paths from setup.vars, changes from setup.makefile_common_changes.

    apply_makefile_mods.py [config.yaml] [--dry-run]
    apply_makefile_mods.py emit-vars [config.yaml]   # print setup.vars as KEY=VALUE for setup_all.bash

Applied to BOTH env dirs (TRUNK_IP_RXEWS_RUN_DIR_PATH + COMMON_RXEWS_RUN_DIR_PATH).
Rule: empty new "" -> leave that variable unchanged (skip). Only variables with a value are applied.
- Backs up each modified file: <file>.bak.<timestamp> (once per run).
- Idempotent: value already correct -> skip.
- Changes the RHS of `VAR = ...` / `:=` / `?=`.
"""
import sys, os, re, datetime
try:
    import yaml
except ImportError:
    sys.exit("pyyaml required: pip install pyyaml")


def load(p):
    with open(p) as f:
        return yaml.safe_load(f) or {}


def default_cfg():
    return os.path.join(os.path.dirname(__file__), "..", "..", "config.yaml")


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from parse_config import _load_setup_vars as setup_vars  # single source of S2 derivation (guide S2)


def backup(path, made, dry):
    if path in made:
        return
    made.add(path)
    if dry:
        print(f"  [dry] backup {path} -> {path}.bak.<ts>")
        return
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    bak = f"{path}.bak.{ts}"
    with open(path) as f:
        data = f.read()
    with open(bak, "w") as f:
        f.write(data)
    print(f"  backup -> {bak}")


def set_var_rhs(text, var, new, export=None):
    """Replace the RHS of `VAR = ...` (keeps operator = / := / ?=). Returns (text, status).
    export: None -> match both `VAR` and `export VAR`; True -> only exported;
    False -> only a plain (non-export) assignment."""
    if export is True:
        exp = r'export[ \t]+'
    elif export is False:
        exp = ''
    else:
        exp = r'(?:export[ \t]+)?'
    pat = re.compile(
        rf'^([ \t]*{exp}{re.escape(var)}[ \t]*)(=|:=|\?=)([ \t]*)(.*?)[ \t]*$',
        re.M)
    m = pat.search(text)
    if not m:
        return text, "not-found"
    cur_rhs = m.group(4).split('#', 1)[0].strip()
    if cur_rhs == new.strip():
        return text, "already"
    new_line = f"{m.group(1)}{m.group(2)}{m.group(3) or ' '}{new}"
    return pat.sub(lambda _m: new_line, text, count=1), "changed"


def apply_file(path, changes, made, dry):
    """changes: list of (key, new, mode) where mode is 'var' (RHS replace) or 'literal' (exact replace). Skip empty new."""
    active = [(k, n, m, e) for k, n, m, e in changes if str(n).strip() != ""]
    if not active:
        print(f"  (no changes with a value for {os.path.basename(path)})")
        return
    if not os.path.isfile(path):
        print(f"  SKIP (file not found): {path}")
        return
    with open(path) as f:
        text = f.read()
    orig = text
    for key, new, mode, export in active:
        if mode == "literal":
            if key in text:
                text = text.replace(key, new, 1)
                st = "changed"
            elif new in text:
                st = "already"
            else:
                st = "not-found"
        else:
            text, st = set_var_rhs(text, key, new, export)
        mark = {"changed": "OK", "already": "=", "not-found": "!!"}[st]
        label = key[:60] + "..." if len(key) > 60 else key
        print(f"    [{mark}] {label} -> {new}" + ("   (not found in file)" if st == "not-found" else ""))
    if text != orig:
        backup(path, made, dry)
        print(f"  {'[dry] would write' if dry else 'wrote'} {path}")
        if not dry:
            with open(path, "w") as f:
                f.write(text)
    else:
        print(f"  unchanged: {path}")


def emit_vars(cfg_path):
    """Print setup.vars as KEY=VALUE for setup_all.bash to eval (only variables with a value)."""
    sv = setup_vars(load(cfg_path))
    for k, v in sv.items():
        v = str(v) if v is not None else ""
        if v.strip() == "":
            continue
        print(f"{k}='{v}'")   # single-quoted for safe bash eval


def _changes_by_file(entries):
    """Group entries into {fname: [(var_or_old, new, mode, export)]}.
    mode is 'var' or 'literal'; export is None/True/False (var mode only)."""
    by_file = {}
    for c in (entries or []):
        fname = c.get("file")
        var, old, new = c.get("var"), c.get("old"), c.get("new", "")
        if not fname:
            print(f"  SKIP incomplete entry (need file): {c}")
            continue
        if var:
            by_file.setdefault(fname, []).append((var, new, "var", c.get("export", None)))
        elif old:
            by_file.setdefault(fname, []).append((old, new, "literal", None))
        else:
            print(f"  SKIP incomplete entry (need var or old): {c}")
    return by_file


def apply_dir(env_dir, by_file, made, dry):
    for fname, chs in by_file.items():
        print(f"  file: {fname}")
        apply_file(os.path.join(env_dir, fname), chs, made, dry)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "emit-vars":
        cfg = sys.argv[2] if len(sys.argv) > 2 else default_cfg()
        emit_vars(cfg)
        return

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    cfg_path = args[0] if args else default_cfg()
    cfg = load(cfg_path)
    sv = setup_vars(cfg)
    setup = cfg.get("setup") or {}

    trunk = str(sv.get("TRUNK_IP_RXEWS_RUN_DIR_PATH", "")).strip().rstrip("/")
    common = str(sv.get("COMMON_RXEWS_RUN_DIR_PATH", "")).strip().rstrip("/")
    if not trunk and not common:
        sys.exit("STOP: set TRUNK_IP_RXEWS_RUN_DIR_PATH / COMMON_RXEWS_RUN_DIR_PATH in config.yaml (setup.vars, one level above auto_env/)")

    common_chg   = _changes_by_file(setup.get("makefile_common_changes") or [])
    trunk_ip_chg = _changes_by_file(setup.get("makefile_trunk_ip_changes") or [])
    common_ip_chg= _changes_by_file(setup.get("makefile_common_ip_changes") or [])

    # BS_PY3/BSIQ/BSBQ: inject -m "DEDICATED_SV" into bs command, applied to both dirs.
    dsv = str(sv.get("DEDICATED_SV", "")).strip()
    bs_chg = {}
    if dsv:
        bs_entries = [
            {"file": "Makefile", "old": f"bs -I -os ${{OS_TYPE_SETUP}}", "new": f'bs -I -os ${{OS_TYPE_SETUP}} -m "{dsv}"'},
            {"file": "Makefile", "old": f"bs -K -os ${{OS_TYPE_SETUP}}", "new": f'bs -K -os ${{OS_TYPE_SETUP}} -m "{dsv}"'},
            {"file": "Makefile", "old": f"bs -B -os ${{OS_TYPE_SETUP}}", "new": f'bs -B -os ${{OS_TYPE_SETUP}} -m "{dsv}"'},
        ]
        bs_chg = _changes_by_file(bs_entries)

    made = set()
    for env_dir, extra in ((trunk, trunk_ip_chg), (common, common_ip_chg)):
        if not env_dir:
            continue
        label = "trunk IP" if env_dir == trunk else "common IP"
        print(f"== common changes @ {env_dir} ({label}) ==")
        apply_dir(env_dir, common_chg, made, dry)
        if bs_chg:
            print(f"== BS host-group changes @ {env_dir} ==")
            apply_dir(env_dir, bs_chg, made, dry)
        if extra:
            print(f"== {label}-only changes @ {env_dir} ==")
            apply_dir(env_dir, extra, made, dry)

    print("== done ==" + ("  (dry-run, nothing written)" if dry else ""))


if __name__ == "__main__":
    main()
