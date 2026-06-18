# Troubleshooting

Answers to common problems. If the problem persists, run with `--debug` to see the full stack trace before reporting.

---

## AUTH ERROR: Not logged in

You haven't logged in yet, or the session for the active profile is missing.

```bash
bee auth profiles          # see which profiles exist and which is active
bee auth login             # log in to the active profile
```

If you're on the right profile but still see this, your `.bee_secret` file may have been deleted or moved, which invalidates the encrypted token:

```bash
bee auth logout            # clear the stale token
bee auth login             # re-login with a fresh token
```

---

## ERROR: No active controller selected

`job`, `node`, and `cred` commands scope to a specific controller. You need to pick one:

```bash
bee controller list
bee controller select <name>
```

---

## ERROR: Controller '<name>' not found

The controller name doesn't match. Names are case-sensitive.

```bash
bee controller list        # confirm the exact name
bee controller select <exact-name>
```

---

## ERROR: Connection refused / cannot reach server

The CloudBees server URL is unreachable — the host is down, the port is wrong, or a firewall/VPN is blocking the connection.

1. Confirm the URL and port are correct:
   ```bash
   bee auth profiles          # shows the server URL for each profile
   ```
2. Check the server is reachable from this machine (VPN up, host resolves):
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' <server-url>
   ```
3. If the URL is wrong, re-login with the correct one:
   ```bash
   bee auth login --url <correct-url> --username ... --token <token>
   ```

---

## ERROR: Certificate / TLS verification failed

The server presents a TLS certificate that can't be verified — typically a self-signed or internal CA certificate not trusted by this machine.

The fix is to trust the CA, not to disable verification. Add your organisation's CA certificate to the system trust store (ask your CloudBees admin for the CA bundle):

```bash
# Debian/Ubuntu
sudo cp your-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

If `bee` still can't connect after the CA is trusted, confirm the server URL uses `https://` and the certificate's hostname matches the URL.

---

## ERROR: 401 / 403 Unauthorized

Your API token is wrong, expired, or your CloudBees account lacks the required permission.

1. Log in to the CloudBees web UI and regenerate your API token under *Profile → Security → API Token*.
2. Re-login:
   ```bash
   bee auth logout
   bee auth login
   ```

403 specifically might also mean your account lacks admin access to the resource (e.g. credential store, node management). Check with your CloudBees admin.

---

## ERROR: 404 Not Found on `job list` / `node list`

Usually means the controller URL is wrong (missing `/` suffix, wrong port) or the endpoint isn't enabled on this controller type.

- Re-select the controller: `bee controller select <name>`
- Try `bee controller info <name>` to see the resolved URL and capabilities.

---

## TUI shows garbled boxes or `?` characters

Your terminal doesn't support Unicode box-drawing characters. Force ASCII mode:

```bash
BEE_ASCII=1 bee --ui
```

Or set it permanently in your shell profile: `export BEE_ASCII=1`.

---

## TUI launches but immediately exits

Requires an interactive terminal (TTY). You cannot pipe `bee --ui` or run it in a non-interactive script. Run it directly in your terminal.

---

## `bee auth login` hangs at the token prompt

The hidden-input reader (`stty -echo`) requires a real terminal. In some restricted shells (e.g. inside `screen` with odd settings), it can stall. Pass the token as a flag to bypass the prompt:

```bash
bee auth login --url ... --username ... --token <token>
```

---

## My tracked jobs/nodes/creds disappeared

Tracking is per (resource type, profile, controller). If you switched profiles or controllers, your Mine list for the previous combination is still there — switch back:

```bash
bee auth use <profile>
bee controller select <controller>
bee job list                   # Mine list for this profile+controller
```

If you moved the binary without moving `data/`, the database didn't come along. See [Concepts → Where data lives](concepts.md#where-data-lives).

---

## `[DELETED_ON_SERVER]` entries in the list

A resource was deleted from the server but still appears in your Mine list. Clean it up:

```bash
bee job untrack <name>
bee node untrack <name>
bee cred untrack <id>
```

---

## `bee ask` returns no results

The query has no close match in the live command tree. Try broader terms:

```bash
bee ask job           # instead of "create freestyle job with params"
bee ask credential    # instead of "add secret"
bee --help            # raw commander help tree
```

---

## Build log `--follow` is very slow

Progressive log streaming polls every 3 seconds. This is intentional to avoid hammering the server. The TUI's log viewer (`Enter → View Log`) uses the same interval.

---

## `bee --install` says "wrapper created" but `bee` isn't found

`~/.local/bin` may not be on your `PATH`. Add it:

```bash
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc or ~/.zshrc
```

---

## Still stuck?

Run the failing command with `--debug` and share the full output when reporting an issue:

```bash
bee --debug <failing command> 2>&1
```
