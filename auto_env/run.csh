#!/usr/bin/env csh
# run.csh [--dry-run] - trigger jobs (manual mode only; auto runs via --schedule on Jenkins).
# Split files are distributed round-robin across jobs; each build gets exactly one SPLIT_FILE.

set AUTO_DIR = "$0:h"
if ( "$AUTO_DIR" !~ /* ) set AUTO_DIR = "$cwd/$AUTO_DIR"
source "$AUTO_DIR/lib.csh"
if ( ! $?LIB_READY ) exit 1

if ( "$1" == "--dry-run" ) set DRY = 1

set mode = "`$PY eff-mode $CONFIG`"
if ( "$mode" == "auto" ) then
  echo "mode=auto -> job runs via --schedule, no manual run needed."
  exit 0
endif

set base  = "`$PY get $CONFIG base_name`"
set root  = "`$PY get $CONFIG rx_auto_root`"
set wait  = "`$PY get $CONFIG manual.wait`"

# resolve RXAUTO_ROOT if rx_auto_root is empty in config (same logic as rxauto.sh)
if ( "$root" == "" ) set root = "$RXAUTO_ROOT"
if ( "$root" == "" ) then
  echo "ERROR: rx_auto_root not set in config.yaml and RXAUTO_ROOT env not set" >& /dev/stderr
  exit 1
endif

foreach ip ("`$PY eff-ip $CONFIG`")
  # eff-ip returns "trunk", "common", or "all" — expand "all" to both
  set iplist = ($ip)
  if ( "$ip" == "all" ) set iplist = (trunk common)

  foreach cur_ip ($iplist)
    echo "== triggering builds for ip=$cur_ip =="
    # plan-splits: SPLIT <jobname> <split_file>  (round-robin)
    foreach line ("`$PY plan-splits $CONFIG $root $cur_ip`")
      set f = ($line)
      if ( "$f[1]" != "SPLIT" ) continue
      set jn = "$f[2]" ; set sf = "$f[3]"

      if ( $?DRY ) then
        echo "[dry] $BEE job run $base/$jn -p IP_MODE=$cur_ip -p SPLIT_FILE=$sf" \
          `if ("$wait" == "true") echo --wait`
      else if ( "$wait" == "true" ) then
        "$BEE" job run "$base/$jn" -p "IP_MODE=$cur_ip" -p "SPLIT_FILE=$sf" --wait
        if ( $status != 0 ) then
          echo "ERROR: build failed for $jn SPLIT_FILE=$sf" >& /dev/stderr ; exit 1
        endif
      else
        "$BEE" job run "$base/$jn" -p "IP_MODE=$cur_ip" -p "SPLIT_FILE=$sf"
        if ( $status != 0 ) then
          echo "ERROR: could not trigger build for $jn SPLIT_FILE=$sf" >& /dev/stderr ; exit 1
        endif
      endif
    end
  end
end
echo "== run done (mode=manual) =="
