#!/bin/csh -f

# Run one bee job and follow logs after 5 seconds.
# Usage:
#   csh scripts/csh/script_run_with_bee.csh <JOB_NAME>
# Example:
#   csh scripts/csh/script_run_with_bee.csh my-job
# Optional:
#   setenv BEE_DIR /path/to/cloudbees

if ($#argv < 1) then
  echo "Usage: $0 <JOB_NAME>"
  exit 1
endif

set JOB_NAME = "$1"

# Resolve bee project directory (BEE_DIR override, fallback to script directory).
set bee_dir = ""
if ($?BEE_DIR) then
  set bee_dir = "$BEE_DIR"
endif
if ("$bee_dir" == "") then
  set script_dir = `dirname "$0"`
  if ("$script_dir" == ".") then
    set bee_dir = `pwd`
  else if ("$script_dir" =~ /*) then
    set bee_dir = "$script_dir"
  else
    set bee_dir = "`pwd`/$script_dir"
  endif
endif

set venv_activate = "$bee_dir/.venv/bin/activate.csh"
if (! -f "$venv_activate") then
  echo "[demo] ERROR: missing $venv_activate"
  echo "[demo] Hint: setenv BEE_DIR /path/to/cloudbees"
  exit 1
endif

echo "[demo] start"
date
sleep 2

echo "[demo] running in tcsh via bs:"
echo "       source $venv_activate; bee job run \"$JOB_NAME\"; sleep 5; bee job log \"$JOB_NAME\" --follow"
bs -os "RHEL7 RHEL8" tcsh -c "if (! \$?prompt) set prompt=''; source \"$venv_activate\"; bee job run \"$JOB_NAME\"; set _bee_code=\$status; sleep 5; bee job log \"$JOB_NAME\" --follow; exit \$_bee_code"
set CMD_STATUS = $status

echo "[demo] bee command exit code: $CMD_STATUS"
sleep 2
echo "[demo] done"
date

exit $CMD_STATUS
