#!/usr/bin/env csh
# deploy.csh [--dry-run] - create/update JOB (the thing that changes: the run command).
# cred+node already exist from provision.csh. Run provision first.
#   manual -> N jobs (work-stealing rx_run)   |  auto -> 1 job with --schedule (go_rx_auto)

set AUTO_DIR = `dirname $0`
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
  foreach line ("`$PY plan-stale-jobs $CONFIG $MANIFEST`")
    set p = ($line)
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
foreach line ("`cat $PLAN`")
  set f = ($line)
  set kind = "$f[1]"

  if ( "$kind" == "FOLDER" ) then
    if ( $?DRY ) then
      echo "[dry] $BEE job create folder $f[2]"
    else
      # idempotent: only create if missing (provision usually made it already).
      "$BEE" job get "$f[2]" >& /dev/null
      if ( $status != 0 ) then
        "$BEE" job create folder "$f[2]"
        if ( $status != 0 ) then
          echo "ERROR: failed to create folder $f[2]" >& /dev/stderr ; rm -f "$PLAN" ; exit 1
        endif
      endif
    endif
    continue
  endif

  if ( "$kind" == "JOB" ) then
    set jn = "$f[2]" ; set folder = "$f[3]" ; set node = "$f[4]"
    set ip = "$f[5]" ; set sched = "$f[6]" ; set sh = "$f[7]"
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
          "$BEE" job update freestyle "$folder/$jn" --shell "$sh" --param-def "IP_MODE=$ip"
        else
          "$BEE" job update freestyle "$folder/$jn" --shell "$sh"
        endif
      else if ( "$sched" != "-" ) then
        "$BEE" job create freestyle "$jn" --folder "$folder" --node "$node" \
          --shell "$sh" --param-def "IP_MODE=$ip" --schedule "$sched_real"
      else if ( "$ip" != "-" ) then
        "$BEE" job create freestyle "$jn" --folder "$folder" --node "$node" \
          --shell "$sh" --param-def "IP_MODE=$ip"
      else
        "$BEE" job create freestyle "$jn" --folder "$folder" --node "$node" \
          --shell "$sh"
      endif
      # only record the job in the manifest if bee actually succeeded.
      set rc = $status
      if ( $rc != 0 ) then
        echo "ERROR: bee job create/update failed for $folder/$jn (rc=$rc)" >& /dev/stderr
        rm -f "$PLAN" ; exit 1
      endif
      echo "job	$folder/$jn" >> "$CREATED"
    endif
  endif
end

rm -f "$PLAN"
if ( ! $?DRY && -e "$CREATED" ) then
  # merge jobs into the existing manifest (keep cred/node)
  $PY merge-jobs $MANIFEST "$CREATED"
  rm -f "$CREATED"
endif
echo "== deploy done. mode=`$PY eff-mode $CONFIG` ip=`$PY eff-ip $CONFIG`. Next: run.csh (manual) or wait for schedule (auto) =="
