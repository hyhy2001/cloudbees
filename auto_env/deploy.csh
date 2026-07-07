#!/usr/bin/env csh
# deploy.csh [--dry-run] - create/update JOB (the thing that changes: the run command).
# cred+node already exist from provision.csh. Run provision first.
#   manual -> N jobs (work-stealing rx_run)   |  auto -> 1 job with --schedule (go_rx_auto)

set AUTO_DIR = `dirname $0`
source "$AUTO_DIR/lib.csh"
if ( "$1" == "--dry-run" ) set DRY = 1

set CREATED = "$AUTO_DIR/.created.jobs.tsv"
rm -f "$CREATED"

# -- PRUNE: delete infra the current config no longer wants (e.g. after manual->auto switch).
# plan-prune reads the manifest: PRUNE_JOB <folder/job> | PRUNE_NODE <node> | PRUNE_CRED <cred-id>.
# Delete order: job -> node -> cred (folder is never pruned). Then rewrite the manifest.
if ( -e "$MANIFEST" ) then
  set pruned = 0
  foreach line ("`$PY plan-prune $CONFIG $MANIFEST`")
    set p = ($line)
    if ( "$p[1]" == "PRUNE_JOB" ) then
      set pruned = 1
      if ( $?DRY ) then
        echo "[dry] $BEE job delete $p[2] --yes"
      else
        echo "prune job $p[2]" ; "$BEE" job delete "$p[2]" --yes
      endif
    else if ( "$p[1]" == "PRUNE_NODE" ) then
      set pruned = 1
      if ( $?DRY ) then
        echo "[dry] $BEE node delete $p[2] --yes"
      else
        echo "prune node $p[2]" ; "$BEE" node delete "$p[2]" --yes
      endif
    else if ( "$p[1]" == "PRUNE_CRED" ) then
      set pruned = 1
      if ( $?DRY ) then
        echo "[dry] $BEE cred delete $p[2] --yes"
      else
        echo "prune cred $p[2]" ; "$BEE" cred delete "$p[2]" --yes
      endif
    endif
  end
  if ( $pruned && ! $?DRY ) $PY prune-manifest $CONFIG $MANIFEST
endif

# plan-jobs: FOLDER <base> | JOB <name> <folder> <node> <ip> <sched_b64|-> <shell_b64>
# plan-setup: appends the rx_setup JOB line (ip="-" -> no IP_MODE param, sched="-" -> no schedule).
foreach line ("`$PY plan-jobs $CONFIG ; $PY plan-setup $CONFIG`")
  set f = ($line)
  set kind = "$f[1]"

  if ( "$kind" == "FOLDER" ) then
    if ( $?DRY ) then
      echo "[dry] $BEE job create folder $f[2]"
    else
      "$BEE" job create folder "$f[2]"
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
        echo "job $jn: exists -> update"
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
      echo "job	$folder/$jn" >> "$CREATED"
    endif
  endif
end

if ( ! $?DRY && -e "$CREATED" ) then
  # merge jobs into the existing manifest (keep cred/node)
  $PY merge-jobs $MANIFEST "$CREATED"
  rm -f "$CREATED"
endif
echo "== deploy done. mode=`$PY get $CONFIG mode`. Next: run.csh (manual) or wait for schedule (auto) =="
