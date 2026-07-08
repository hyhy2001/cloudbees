#!/usr/bin/env csh
# manage.csh <list|run|teardown|prune> [--dry-run] - operate from the complete.yml manifest.
#   list      : print created cred/node/job
#   run       : re-run every job in the manifest (uses each job's default params)
#   teardown  : delete EVERYTHING: job -> node -> cred -> folder (reverse of creation order)
#   prune     : delete only what the CURRENT config no longer wants (deploy just clears schedules)
# The manifest stores the REAL cred-id (bee auto-generates a random one), so teardown/run never guess names.

set AUTO_DIR = "$0:h"
if ( "$AUTO_DIR" !~ /* ) set AUTO_DIR = "$cwd/$AUTO_DIR"
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

# helper: iterate a manifest list via temp file (avoids csh word-split on multi-line backtick)
set _tmp = "$AUTO_DIR/.manage.$$.tmp"

if ( "$action" == "run" ) then
  $PY manifest-list $MANIFEST jobs >! "$_tmp"
  while ( 1 )
    set j = ( `head -1 "$_tmp"` )
    if ( $#j == 0 ) break
    sed -i '1d' "$_tmp"
    if ( $?DRY ) then
      echo "[dry] $BEE job run $j[1]"
    else
      "$BEE" job run "$j[1]"
    endif
  end
  rm -f "$_tmp"
  echo "== run-all done =="
  exit 0
endif

if ( "$action" == "teardown" ) then
  # jobs first
  $PY manifest-list $MANIFEST jobs >! "$_tmp"
  while ( 1 )
    set j = ( `head -1 "$_tmp"` )
    if ( $#j == 0 ) break
    sed -i '1d' "$_tmp"
    if ( $?DRY ) then
      echo "[dry] $BEE job delete $j[1] --yes"
    else
      "$BEE" job delete "$j[1]" --yes
    endif
  end
  rm -f "$_tmp"
  # nodes
  $PY manifest-list $MANIFEST nodes >! "$_tmp"
  while ( 1 )
    set n = ( `head -1 "$_tmp"` )
    if ( $#n == 0 ) break
    sed -i '1d' "$_tmp"
    if ( $?DRY ) then
      echo "[dry] $BEE node delete $n[1] --yes"
    else
      "$BEE" node delete "$n[1]" --yes
    endif
  end
  rm -f "$_tmp"
  # creds (by the real cred-id from the manifest)
  $PY manifest-list $MANIFEST credentials >! "$_tmp"
  while ( 1 )
    set c = ( `head -1 "$_tmp"` )
    if ( $#c == 0 ) break
    sed -i '1d' "$_tmp"
    if ( $?DRY ) then
      echo "[dry] $BEE cred delete $c[1] --yes"
    else
      "$BEE" cred delete "$c[1]" --yes
    endif
  end
  rm -f "$_tmp"
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
  set did = 0
  set failed = 0
  $PY plan-prune $CONFIG $MANIFEST >! "$_tmp"
  while ( 1 )
    set p = ( `head -1 "$_tmp"` )
    if ( $#p == 0 ) break
    sed -i '1d' "$_tmp"
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
  rm -f "$_tmp"
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
