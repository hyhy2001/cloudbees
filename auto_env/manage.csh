#!/usr/bin/env csh
# manage.csh <list|run|teardown|prune> [--dry-run] - operate from the complete.yml manifest.
#   list      : print created cred/node/job
#   run       : re-run every job in the manifest (uses each job's default params)
#   teardown  : delete EVERYTHING: job -> node -> cred -> folder (reverse of creation order)
#   prune     : delete only what the CURRENT config no longer wants (deploy just clears schedules)
# The manifest stores the REAL cred-id (bee auto-generates a random one), so teardown/run never guess names.

set AUTO_DIR = `cd "$0:h" && pwd`
source "$AUTO_DIR/lib.csh"
if ( ! $?LIB_READY ) exit 1   # lib.csh failed (exit inside a sourced file doesn't stop us)

# action = first non-flag arg; --dry-run may appear in any position.
set action = ""
foreach a ($argv)
  if ( "$a" == "--dry-run" ) then
    set DRY = 1
  else if ( "$action" == "" ) then
    set action = "$a"
  endif
end

if ( ! -e "$MANIFEST" ) then
  echo "No $MANIFEST yet - run provision.csh + deploy.csh first." ; exit 1
endif
set base = "`$PY get $MANIFEST base_name`"

if ( "$action" == "list" ) then
  echo "== manifest $MANIFEST (base=$base) =="
  echo "-- jobs --"  ; $PY manifest-list $MANIFEST jobs
  echo "-- nodes --" ; $PY manifest-list $MANIFEST nodes
  echo "-- creds --" ; $PY manifest-list $MANIFEST credentials
  exit 0
endif

if ( "$action" == "run" ) then
  foreach j ("`$PY manifest-list $MANIFEST jobs`")
    if ( $?DRY ) then
      echo "[dry] $BEE job run $j"
    else
      "$BEE" job run "$j"
    endif
  end
  echo "== run-all done =="
  exit 0
endif

if ( "$action" == "teardown" ) then
  # jobs first
  foreach j ("`$PY manifest-list $MANIFEST jobs`")
    if ( $?DRY ) then
      echo "[dry] $BEE job delete $j --yes"
    else
      "$BEE" job delete "$j" --yes
    endif
  end
  # nodes
  foreach n ("`$PY manifest-list $MANIFEST nodes`")
    if ( $?DRY ) then
      echo "[dry] $BEE node delete $n --yes"
    else
      "$BEE" node delete "$n" --yes
    endif
  end
  # creds (by the real cred-id from the manifest)
  foreach c ("`$PY manifest-list $MANIFEST credentials`")
    if ( $?DRY ) then
      echo "[dry] $BEE cred delete $c --yes"
    else
      "$BEE" cred delete "$c" --yes
    endif
  end
  # folder last
  if ( $?DRY ) then
    echo "[dry] $BEE job delete $base --yes"
  else
    "$BEE" job delete "$base" --yes
  endif
  echo "== teardown done =="
  exit 0
endif

if ( "$action" == "prune" ) then
  # DESTRUCTIVE opt-in: delete infra the CURRENT config no longer wants (deploy only clears
  # schedules; prune actually removes). plan-prune: PRUNE_JOB|PRUNE_NODE|PRUNE_CRED. folder kept.
  # Only rewrite the manifest if EVERY delete succeeded - otherwise a failed delete would leave
  # a live resource with no manifest record (orphan). On any failure we keep the manifest intact
  # so a re-run retries the same set.
  set did = 0
  set failed = 0
  foreach line ("`$PY plan-prune $CONFIG $MANIFEST`")
    set p = ($line)
    set what = "" ; set arg = ""
    if ( "$p[1]" == "PRUNE_JOB" ) then
      set what = job ; set arg = "$p[2]"
    else if ( "$p[1]" == "PRUNE_NODE" ) then
      set what = node ; set arg = "$p[2]"
    else if ( "$p[1]" == "PRUNE_CRED" ) then
      set what = cred ; set arg = "$p[2]"
    else
      continue
    endif
    set did = 1
    if ( $?DRY ) then
      echo "[dry] $BEE $what delete $arg --yes"
    else
      echo "prune $what $arg"
      "$BEE" $what delete "$arg" --yes
      if ( $status != 0 ) then
        echo "WARNING: failed to delete $what $arg - keeping it in the manifest" >& /dev/stderr
        set failed = 1
      endif
    endif
  end
  if ( ! $did ) echo "nothing to prune (config matches manifest)"
  if ( $did && ! $?DRY ) then
    if ( $failed ) then
      echo "prune: some deletes failed -> manifest NOT rewritten (re-run after fixing)" >& /dev/stderr
      exit 1
    endif
    $PY prune-manifest $CONFIG $MANIFEST
  endif
  echo "== prune done =="
  exit 0
endif

echo "usage: manage.csh <list|run|teardown|prune> [--dry-run]"
exit 1
