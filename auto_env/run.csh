#!/usr/bin/env csh
# run.csh [--dry-run] - trigger jobs (manual mode only; auto runs via --schedule on Jenkins).
# Switch common<->trunk next time: just edit config then run.csh, no redeploy needed
# (IP_MODE is a build param passed at run time; module splits are claimed at runtime).

set AUTO_DIR = `dirname $0`
source "$AUTO_DIR/lib.csh"
if ( ! $?LIB_READY ) exit 1   # lib.csh failed (exit inside a sourced file doesn't stop us)
if ( "$1" == "--dry-run" ) set DRY = 1

set mode = "`$PY eff-mode $CONFIG`"
if ( "$mode" == "auto" ) then
  echo "mode=auto -> job runs via --schedule on Jenkins, no manual run. (see deploy.csh)"
  exit 0
endif

# plan-run: RUN <jobname> <ip> <wait 0|1>
set base = "`$PY get $CONFIG base_name`"
foreach line ("`$PY plan-run $CONFIG`")
  set f = ($line)
  if ( "$f[1]" != "RUN" ) continue
  set jn = "$f[2]" ; set ip = "$f[3]" ; set wait = "$f[4]"

  if ( $?DRY ) then
    echo "[dry] $BEE job run $base/$jn -p IP_MODE=$ip" `if ("$wait" == 1) echo --wait`
  else if ( "$wait" == "1" ) then
    "$BEE" job run "$base/$jn" -p "IP_MODE=$ip" --wait
  else
    "$BEE" job run "$base/$jn" -p "IP_MODE=$ip"
  endif
end
echo "== run done (mode=manual) =="
