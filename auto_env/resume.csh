#!/usr/bin/env csh
# resume.csh [--dry-run] - restore schedule on auto jobs from config (undo pause).

set AUTO_DIR = `cd "$0:h" && pwd`
source "$AUTO_DIR/lib.csh"
if ( ! $?LIB_READY ) exit 1

if ( "$1" == "--dry-run" ) set DRY = 1

set base  = "`$PY get $CONFIG base_name`"
set jn0   = "`$PY get $CONFIG auto.job_name`"
set sched = "`$PY get $CONFIG auto.schedule`"
if ( "$jn0" == "" ) set jn0 = "daily"
if ( "$sched" == "" ) then
  echo "ERROR: auto.schedule is empty in config — nothing to restore" >& /dev/stderr ; exit 1
endif

foreach ip (trunk common)
  foreach jn ("${jn0}_${ip}" "$jn0")
    "$BEE" job get "$base/$jn" >& /dev/null
    if ( $status != 0 ) continue
    if ( $?DRY ) then
      echo "[dry] $BEE job update freestyle $base/$jn --schedule '$sched' (resume)"
    else
      "$BEE" job update freestyle "$base/$jn" --schedule "$sched"
      if ( $status == 0 ) echo "resumed $base/$jn (schedule: $sched)"
    endif
    break
  end
end
echo "== resume done. =="
