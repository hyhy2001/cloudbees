#!/usr/bin/env csh
# deploy.csh [--dry-run] - create/update JOB (the thing that changes: the run command).
# cred+node already exist from provision.csh. Run provision first.
#   manual -> N jobs (work-stealing rx_run)   |  auto -> 1 job with --schedule (go_rx_auto)

set AUTO_DIR = "$0:h"
if ( "$AUTO_DIR" !~ /* ) set AUTO_DIR = "$cwd/$AUTO_DIR"
source "$AUTO_DIR/lib.csh"
if ( ! $?LIB_READY ) exit 1   # lib.csh failed (exit inside a sourced file doesn't stop us)
if ( "$1" == "--dry-run" ) set DRY = 1

set CREATED = "$AUTO_DIR/.created.jobs.tsv"
rm -f "$CREATED"

# -- STALE JOBS: jobs in the manifest the current plan no longer includes (e.g. auto->manual).
# We KEEP the job (and its node/cred) but clear its schedule so its timer stops firing.
# `bee job update freestyle --schedule ''` removes the cron trigger without deleting the job.
# Destructive removal is a separate opt-in step: manage.csh prune.
if ( -e "$MANIFEST" ) then
  set _stale_tmp = "$AUTO_DIR/.stale.$$"
  $PY plan-stale-jobs $CONFIG $MANIFEST >! "$_stale_tmp"
  while ( 1 )
    set p = ( `head -1 "$_stale_tmp"` )
    if ( $#p == 0 ) break
    sed -i '1d' "$_stale_tmp"
    if ( "$p[1]" != "STALE_JOB" ) continue
    if ( $?DRY ) then
      echo "[dry] $BEE job update freestyle $p[2] --schedule '' (keep job, stop timer)"
    else
      echo "stale $p[2] - clear schedule (job kept)"
      "$BEE" job update freestyle "$p[2]" --schedule ""
      if ( $status != 0 ) then
        echo "WARNING: could not clear schedule on stale job $p[2] (it may keep firing)" >& /dev/stderr
      endif
    endif
  end
  rm -f "$_stale_tmp"
endif

# Build the plan into a temp file FIRST so a plan-jobs / plan-setup failure (e.g. empty command)
# is caught here instead of being swallowed by a chained backtick.
set PLAN = "$AUTO_DIR/.plan.tsv"
rm -f "$PLAN"
$PY plan-jobs $CONFIG >> "$PLAN"
if ( $status != 0 ) then
  echo "ERROR: plan-jobs failed - see message above. Aborting deploy." >& /dev/stderr
  rm -f "$PLAN" ; exit 1
endif
$PY plan-setup $CONFIG >> "$PLAN"
if ( $status != 0 ) then
  echo "ERROR: plan-setup failed - see message above. Aborting deploy." >& /dev/stderr
  rm -f "$PLAN" ; exit 1
endif

# plan-jobs: FOLDER <base> | JOB <name> <folder> <node> <ip> <sched_b64|-> <shell_b64>
# plan-setup: appends the rx_setup JOB line (ip="-" -> no IP_MODE param, sched="-" -> no schedule).
# NOTE: read fields with `cut -f` (tab-delimited), NOT csh word-split. The last field
# (shell_b64 = "echo <b64> | base64 -d | bash") CONTAINS SPACES, so `set f = (\`head\`)`
# would split it and $f[7] would only capture "echo". cut -f keeps each field intact.
set _plan_tmp = "$PLAN"
set _row_tmp = "$AUTO_DIR/.plan_row.$$"
while ( 1 )
  head -1 "$_plan_tmp" >! "$_row_tmp"
  if ( -z "$_row_tmp" ) break
  sed -i '1d' "$_plan_tmp"
  # cut -f reads tab-delimited fields; the shell_b64 field has spaces so csh
  # word-split is unusable here — cut from the single-row file keeps fields whole.
  set kind = "`cut -f1 $_row_tmp`"

  if ( "$kind" == "FOLDER" ) then
    set _fbase = "`cut -f2 $_row_tmp`"
    if ( $?DRY ) then
      echo "[dry] $BEE job create folder $_fbase"
    else
      # idempotent: only create if missing (provision usually made it already).
      "$BEE" job get "$_fbase" >& /dev/null
      if ( $status != 0 ) then
        "$BEE" job create folder "$_fbase"
        if ( $status != 0 ) then
          echo "ERROR: failed to create folder $_fbase" >& /dev/stderr ; rm -f "$PLAN" "$_row_tmp" ; exit 1
        endif
      endif
    endif
    continue
  endif

  if ( "$kind" == "JOB" ) then
    set jn = "`cut -f2 $_row_tmp`" ; set folder = "`cut -f3 $_row_tmp`" ; set node = "`cut -f4 $_row_tmp`"
    set ip = "`cut -f5 $_row_tmp`" ; set sched = "`cut -f6 $_row_tmp`" ; set sh = "`cut -f7 $_row_tmp`"
    # sched is b64 (cron string has spaces) or "-" (no schedule). Decode when used.
    set sched_real = ""
    if ( "$sched" != "-" ) set sched_real = "`echo $sched | base64 -d`"
    # ip="-" (setup job) -> no IP_MODE param; else pass --param-def IP_MODE=<ip>.
    set ipopt = ""
    if ( "$ip" != "-" ) set ipopt = "--param-def IP_MODE=$ip"

    # already exists? (update in place, keep node/folder)
    set exists = 0
    "$BEE" job get "$folder/$jn" >& /dev/null
    if ( $status == 0 ) set exists = 1

    if ( $?DRY ) then
      if ( $exists ) then
        echo "[dry] $BEE job update freestyle $folder/$jn --shell <b64> $ipopt"
      else if ( "$sched" != "-" ) then
        echo "[dry] $BEE job create freestyle $jn --folder $folder --node $node --shell <b64> $ipopt --schedule '$sched_real'"
      else
        echo "[dry] $BEE job create freestyle $jn --folder $folder --node $node --shell <b64> $ipopt"
      endif
    else
      if ( $exists ) then
        echo "job ${jn}: exists -> update"
        if ( "$ip" != "-" ) then
          "$BEE" job update freestyle "$folder/$jn" --shell "$sh" --param-def "IP_MODE=$ip" --param-def "SPLIT_FILE="
        else
          # ip="-" -> the rx_setup job: expose PHASE (default all) so run-setup can pick a sub-step.
          "$BEE" job update freestyle "$folder/$jn" --shell "$sh" --param-def "PHASE=all"
        endif
      else if ( "$sched" != "-" ) then
        "$BEE" job create freestyle "$jn" --folder "$folder" --node "$node" \
          --shell "$sh" --param-def "IP_MODE=$ip" --schedule "$sched_real"
      else if ( "$ip" != "-" ) then
        "$BEE" job create freestyle "$jn" --folder "$folder" --node "$node" \
          --shell "$sh" --param-def "IP_MODE=$ip" --param-def "SPLIT_FILE="
      else
        "$BEE" job create freestyle "$jn" --folder "$folder" --node "$node" \
          --shell "$sh" --param-def "PHASE=all"
      endif
      # only record the job in the manifest if bee actually succeeded.
      set rc = $status
      if ( $rc != 0 ) then
        echo "ERROR: bee job create/update failed for $folder/$jn (rc=$rc)" >& /dev/stderr
        rm -f "$PLAN" "$_row_tmp" ; exit 1
      endif
      echo "job	$folder/$jn" >> "$CREATED"
    endif
  endif
end

rm -f "$PLAN" "$_row_tmp"
if ( ! $?DRY && -e "$CREATED" ) then
  # merge jobs into the existing manifest (keep cred/node)
  $PY merge-jobs $MANIFEST "$CREATED"
  rm -f "$CREATED"
endif
echo "== deploy done. mode=`$PY eff-mode $CONFIG` ip=`$PY eff-ip $CONFIG`. Next: run.csh (manual) or wait for schedule (auto) =="
