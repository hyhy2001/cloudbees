#!/usr/bin/env csh
# provision.csh [--dry-run] - build CloudBees infra: folder -> cred + node.
# Idempotent: a cred already in complete.yml is reused (users rarely change). Jobs are NOT created here.
#   -> use deploy.csh to (re)create jobs.
# NOTE: RX AUTO step 1-2 (setup_all.bash) runs SEPARATELY, outside CloudBees - not called from here.

set AUTO_DIR = "$0:h"
if ( "$AUTO_DIR" !~ /* ) set AUTO_DIR = "$cwd/$AUTO_DIR"
source "$AUTO_DIR/lib.csh"
if ( ! $?LIB_READY ) exit 1   # lib.csh failed (exit inside a sourced file doesn't stop us)

if ( "$1" == "--dry-run" ) set DRY = 1

set CREATED = "$AUTO_DIR/.created.tsv"
rm -f "$CREATED"

# -- folder + cred/node from plan-infra --
set BASE = "`$PY get $CONFIG base_name`"
echo "== folder $BASE =="
if ( $?DRY ) then
  echo "[dry] $BEE job create folder $BASE"
else
  # idempotent: skip create if the folder already exists; else create and verify it succeeded.
  "$BEE" job get "$BASE" >& /dev/null
  if ( $status != 0 ) then
    "$BEE" job create folder "$BASE"
    if ( $status != 0 ) then
      echo "ERROR: failed to create folder $BASE" >& /dev/stderr ; exit 1
    endif
  endif
  echo "folder	$BASE" >> "$CREATED"
endif

# plan-infra emits one line per account: ACCT <user> <nodename> <host> <port> <remotedir> <executors>
# Use a temp file + while-read to avoid csh word-split collapsing all lines into one list.
set _infra_tmp = "$AUTO_DIR/.infra_lines.$$"
$PY plan-infra $CONFIG >! "$_infra_tmp"
while ( 1 )
  set line = ( `head -1 "$_infra_tmp"` )
  if ( $#line == 0 ) break
  # remove first line from temp file
  sed -i '1d' "$_infra_tmp"
  if ( "$line[1]" != "ACCT" ) continue
  set user = "$line[2]" ; set nname = "$line[3]" ; set host = "$line[4]"
  set port = "$line[5]" ; set rdir = "$line[6]" ; set nexec = "$line[7]"

  # -- cred: reuse if the manifest already has one (users rarely change), else create --
  set cid = "`$PY manifest-cred $MANIFEST $user`"
  if ( "$cid" != "" ) then
    echo "cred ${user}: reuse $cid"
  else if ( $?DRY ) then
    echo "[dry] $BEE cred create --username $user --password *** --description '$BASE $user'"
    set cid = "DRY_CRED_$user"
  else
    # deterministic cred-id (--id): we set it to the node name, so no fragile stdout parsing.
    set cid = "$nname"
    # idempotent: skip create if a cred with this id already exists (manifest may have been lost).
    "$BEE" cred get "$cid" >& /dev/null
    if ( $status == 0 ) then
      echo "cred ${user}: exists -> reuse $cid"
    else
      set pass = "`$PY cred-pass $CONFIG $user`"
      set desc = "${BASE}_${user}"
      "$BEE" cred create --id "$cid" --username "$user" --password "$pass" --description "$desc"
      if ( $status != 0 ) then
        echo "ERROR: failed to create cred $cid for $user" >& /dev/stderr ; exit 1
      endif
      echo "cred $user -> $cid"
    endif
  endif
  if ( ! $?DRY ) then
    echo "cred	$user	$cid" >> "$CREATED"
  endif

  # -- node: use the cred-id just obtained --
  if ( $?DRY ) then
    echo "[dry] $BEE node create $nname --host $host --port $port --cred-id $cid --remote-dir $rdir --executors $nexec"
  else
    # idempotent: skip if the node already exists; else create and verify. Fail loud (don't
    # write a manifest entry for a node that was never created).
    "$BEE" node get "$nname" >& /dev/null
    if ( $status != 0 ) then
      "$BEE" node create "$nname" --host "$host" --port "$port" \
        --cred-id "$cid" --remote-dir "$rdir" --executors "$nexec"
      if ( $status != 0 ) then
        echo "ERROR: failed to create node $nname" >& /dev/stderr ; exit 1
      endif
    endif
    echo "node	$nname" >> "$CREATED"
  endif
end
rm -f "$_infra_tmp"

# -- write complete.yml manifest --
if ( ! $?DRY ) then
  $PY write-manifest $CONFIG "$CREATED" "$MANIFEST"
  rm -f "$CREATED"
endif

# -- environment warning --
set host_c = "`$PY get $CONFIG node.host`"
if ( "$host_c" == "localhost" || "$host_c" == "127.0.0.1" ) then
  echo "WARNING: host=localhost + sshd PasswordAuthentication no -> node will be offline, jobs PENDING."
endif
echo "== provision done. Next: deploy.csh =="
