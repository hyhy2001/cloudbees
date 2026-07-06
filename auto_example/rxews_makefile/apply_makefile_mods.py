#!/usr/bin/env python3
"""Apply RXEWS Makefile modifications (guide S4, COMMON CHANGES ONLY) - prerequisite step 1.
Reads setup.yaml: env dir paths from setup_vars, changes from makefile_common_changes.

    apply_makefile_mods.py [setup.yaml] [--dry-run]
    apply_makefile_mods.py emit-vars [setup.yaml]   # print setup_vars as KEY=VALUE for setup_all.bash

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


def set_var_rhs(text, var, new):
    """Replace the RHS of `VAR = ...` (keeps operator = / := / ?=). Returns (text, status)."""
    pat = re.compile(rf'^([ \t]*{re.escape(var)}[ \t]*)(=|:=|\?=)([ \t]*)(.*)$', re.M)
    m = pat.search(text)
    if not m:
        return text, "not-found"
    cur_rhs = m.group(4).split('#', 1)[0].strip()
    if cur_rhs == new.strip():
        return text, "already"
    new_line = f"{m.group(1)}{m.group(2)}{m.group(3) or ' '}{new}"
    return pat.sub(lambda _m: new_line, text, count=1), "changed"


def apply_file(path, changes, made, dry):
    """changes: list of (var, new). Read once, apply all, write once. Skip empty new."""
    active = [(v, n) for v, n in changes if str(n).strip() != ""]
    if not active:
        print(f"  (no changes with a value for {os.path.basename(path)})")
        return
    if not os.path.isfile(path):
        print(f"  SKIP (file not found): {path}")
        return
    with open(path) as f:
        text = f.read()
    orig = text
    for var, new in active:
        text, st = set_var_rhs(text, var, new)
        mark = {"changed": "OK", "already": "=", "not-found": "!!"}[st]
        print(f"    [{mark}] {var} -> {new}" + ("   (not found in file)" if st == "not-found" else ""))
    if text != orig:
        backup(path, made, dry)
        print(f"  {'[dry] would write' if dry else 'wrote'} {path}")
        if not dry:
            with open(path, "w") as f:
                f.write(text)
    else:
        print(f"  unchanged: {path}")


def emit_vars(cfg_path):
    """Print setup_vars as KEY=VALUE for setup_all.bash to eval (only variables with a value)."""
    sv = load(cfg_path).get("setup_vars", {})
    for k, v in sv.items():
        v = str(v) if v is not None else ""
        if v.strip() == "":
            continue
        print(f"{k}='{v}'")   # single-quoted for safe bash eval


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "emit-vars":
        cfg = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "setup.yaml")
        emit_vars(cfg)
        return

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    cfg_path = args[0] if args else os.path.join(os.path.dirname(__file__), "setup.yaml")
    cfg = load(cfg_path)
    sv = cfg.get("setup_vars", {})
    by_file = {}
    for c in (cfg.get("makefile_common_changes") or []):
        by_file.setdefault(c["file"], []).append((c["var"], c.get("new", "")))

    trunk = str(sv.get("TRUNK_IP_RXEWS_RUN_DIR_PATH", "")).strip().rstrip("/")
    common = str(sv.get("COMMON_RXEWS_RUN_DIR_PATH", "")).strip().rstrip("/")
    if not trunk and not common:
        sys.exit("STOP: set TRUNK_IP_RXEWS_RUN_DIR_PATH / COMMON_RXEWS_RUN_DIR_PATH in setup.yaml")

    made = set()
    for env_dir in (trunk, common):
        if not env_dir:
            continue
        print(f"== common changes @ {env_dir} ==")
        for fname, chs in by_file.items():
            print(f"  file: {fname}")
            apply_file(os.path.join(env_dir, fname), chs, made, dry)

    print("== done ==" + ("  (dry-run, nothing written)" if dry else ""))


if __name__ == "__main__":
    main()
