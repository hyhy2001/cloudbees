#!/usr/bin/env csh
# manage.csh <list|teardown|run> [--dry-run] - operate from the complete.yml manifest.
#   list      : print created cred/node/job
#   teardown  : delete job -> node -> cred -> folder (reverse of creation order)
#   run       : re-run every job in the manifest (uses each job's default params)
# The manifest stores the REAL cred-id (bee auto-generates a random one), so teardown/run never guess names.

set AUTO_DIR = `dirname $0`
source "$AUTO_DIR/lib.csh"

set action = "$1"
if ( "$2" == "--dry-run" ) set DRY = 1

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

echo "usage: manage.csh <list|teardown|run> [--dry-run]"
exit 1
