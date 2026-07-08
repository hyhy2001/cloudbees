#!/usr/bin/env csh
# pause.csh [--dry-run] - clear schedule on auto jobs (jobs kept, just stop firing).
# resume.csh restores the schedule from config. Only affects auto mode jobs.

set AUTO_DIR = `cd "$0:h" && pwd`
source "$AUTO_DIR/lib.csh"
if ( ! $?LIB_READY ) exit 1

if ( "$1" == "--dry-run" ) set DRY = 1

set base  = "`$PY get $CONFIG base_name`"
set jn0   = "`$PY get $CONFIG auto.job_name`"
if ( "$jn0" == "" ) set jn0 = "daily"

foreach ip (trunk common)
  # try both daily_trunk/daily_common and plain daily (single-ip deployment)
  foreach jn ("${jn0}_${ip}" "$jn0")
    "$BEE" job get "$base/$jn" >& /dev/null
    if ( $status != 0 ) continue
    if ( $?DRY ) then
      echo "[dry] $BEE job update freestyle $base/$jn --schedule '' (pause)"
    else
      "$BEE" job update freestyle "$base/$jn" --schedule ""
      if ( $status == 0 ) echo "paused $base/$jn"
    endif
    break   # found the right name, skip the other variant
  end
end
echo "== pause done. Run 'rxauto.sh resume' to restore the schedule. =="
