#!/usr/bin/env csh
# provision.csh [--dry-run] - build CloudBees infra: folder -> cred + node.
# Idempotent: a cred already in complete.yml is reused (users rarely change). Jobs are NOT created here.
#   -> use deploy.csh to (re)create jobs.
# NOTE: RX AUTO step 1-2 (setup_all.bash) runs SEPARATELY, outside CloudBees - not called from here.

set AUTO_DIR = `dirname $0`
source "$AUTO_DIR/lib.csh"

if ( "$1" == "--dry-run" ) set DRY = 1

set CREATED = "$AUTO_DIR/.created.tsv"
rm -f "$CREATED"

# -- folder + cred/node from plan-infra --
set BASE = "`$PY get $CONFIG base_name`"
echo "== folder $BASE =="
if ( $?DRY ) then
  echo "[dry] $BEE job create folder $BASE"
else
  "$BEE" job create folder "$BASE"
  echo "folder	$BASE" >> "$CREATED"
endif

# plan-infra emits one line per account: ACCT <user> <nodename> <host> <port> <remotedir> <executors>
foreach line ("`$PY plan-infra $CONFIG`")
  set f = ($line)
  if ( "$f[1]" != "ACCT" ) continue
  set user = "$f[2]" ; set nname = "$f[3]" ; set host = "$f[4]"
  set port = "$f[5]" ; set rdir = "$f[6]" ; set nexec = "$f[7]"

  # -- cred: reuse if the manifest already has one (users rarely change), else create --
  set cid = "`$PY manifest-cred $MANIFEST $user`"
  if ( "$cid" != "" ) then
    echo "cred $user: reuse $cid"
  else if ( $?DRY ) then
    echo "[dry] $BEE cred create --username $user --password *** --description '$BASE $user'"
    set cid = "DRY_CRED_$user"
  else
    # password read raw (no word-split); bee generates a UUID -> capture it from stdout
    set pass = "`$PY cred-pass $CONFIG $user`"
    set out = "`$BEE cred create --username $user --password $pass:q --description $BASE:q`"
    set cid = "`echo $out | sed -n 's/.*Credential .\([^ ]*\). created.*/\1/p'`"
    if ( "$cid" == "" ) then
      echo "ERROR: could not capture cred-id for $user. Output: $out" ; exit 1
    endif
    echo "cred $user -> $cid"
  endif
  if ( ! $?DRY ) echo "cred	$user	$cid" >> "$CREATED"

  # -- node: use the cred-id just obtained --
  if ( $?DRY ) then
    echo "[dry] $BEE node create $nname --host $host --port $port --cred-id $cid --remote-dir $rdir --executors $nexec"
  else
    "$BEE" node create "$nname" --host "$host" --port "$port" \
      --cred-id "$cid" --remote-dir "$rdir" --executors "$nexec"
    echo "node	$nname" >> "$CREATED"
  endif
end

# -- write complete.yml manifest --
if ( ! $?DRY ) then
  $PY write-manifest $CONFIG "$CREATED" "$MANIFEST"
  rm -f "$CREATED"
endif

# -- environment warning --
set host_c = "`$PY get $CONFIG node.host_common`"
if ( "$host_c" == "localhost" || "$host_c" == "127.0.0.1" ) then
  echo "WARNING: host=localhost + sshd PasswordAuthentication no -> node will be offline, jobs PENDING."
endif
echo "== provision done. Next: deploy.csh =="
