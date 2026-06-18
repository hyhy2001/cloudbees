# Concepts

Understanding these four ideas will make every other `bee` doc click faster.

## Profiles

A **profile** is a saved identity: one (server URL + username + encrypted token). Profiles let you manage multiple CloudBees servers or multiple accounts without re-typing credentials every time.

- The **active profile** is the one all commands use by default.
- The first profile you log in to becomes the default.
- Switch profiles with `bee auth use <name>` or `Shift+P` in the TUI.
- Each profile remembers its own active controller separately.

```
Profile: default           Profile: staging
URL: cloudbees.example.com URL: cloudbees-staging.example.com
User: alice                User: alice
Active controller: prod    Active controller: test-ctrl
```

`bee auth profiles` lists everything. The `*` column marks the currently active one.

## Controllers

A CloudBees CI server hosts one or more **controllers** — the Jenkins masters that actually manage and run jobs, nodes, and credentials. You have to tell `bee` which controller to target before you can do anything with jobs/nodes/creds.

```bash
bee controller list             # discover available controllers
bee controller select <name>    # point everything at this one
bee controller current          # check which one is active
```

Commands that need a controller (`job`, `node`, `cred`) fail with a clear message if none is selected. The selection persists in the DB — you only select once per profile, not every session.

## "Mine" vs "All"

By default, `job list`, `node list`, and `cred list` show only **your resources** — things you created through `bee` or explicitly tracked. This is called the **Mine list**.

- Pass `--all` to see everything on the server.
- `bee job track <name>` / `bee node track <name>` / `bee cred track <id>` adds a pre-existing server resource to your Mine list.
- Resources in Mine that no longer exist on the server show as `[DELETED_ON_SERVER]` so you know to clean them up.
- The TUI has `Ctrl+a` to toggle between Mine and All views per tab.

Tracking is scoped to (resource type, profile, controller) — the same job name tracked under two different controllers are independent entries.

## Cache

`bee` caches server responses in the local SQLite DB so tab-switches in the TUI don't refetch everything from scratch. Typical TTLs:

| Resource | Cache duration |
|---|---|
| Job list | 15 seconds |
| Job details | 20 seconds |
| Controller list / details | 60 seconds |
| Controller capabilities | 5 minutes |
| Nodes / credentials | 30 seconds |

Write operations (`create`, `update`, `delete`) **immediately invalidate** the relevant cache entries — you always see the up-to-date state after a write.

In the TUI, `r` forces a refetch now. On the Info tab, `Ctrl+x` clears the entire cache.

## Where Data Lives

`bee` keeps all local state in a single SQLite file. It lives **next to the binary** by default:

```
~/.local/bin/bee          ← the binary you put on PATH
~/.local/bin/data/cb.db   ← the database
~/.local/bin/.bee_secret  ← the encryption key file (chmod 600)
```

This means:

- Moving the binary without moving `data/` loses your login and tracked resources.
- Two copies of `bee` in different directories have **separate databases** — login once per binary location.
- Override with `CB_DB_PATH` to share one database across multiple copies. See [Environment Variables](env-vars.md).

## Security

API tokens are encrypted on disk with **AES-256-GCM**. The key is derived from a random 32-byte secret stored in `.bee_secret` (mode `0600`, beside the DB). A stolen database file alone cannot recover your token — the attacker also needs `.bee_secret` and must be running as your OS user (the UID is mixed into the key derivation).

`bee auth logout` clears your token from the DB. Deleting `.bee_secret` forces re-login on next run.

CSRF crumbs are fetched automatically for every write request — you never need to manage them manually.

## Global Options

These flags work with any command:

| Flag | Effect |
|---|---|
| `--version` / `-V` | Print version |
| `--debug` | Full error stack traces |
| `--ui` | Launch the TUI |
| `--install` | Create `bee.csh` wrapper + symlink to `~/.local/bin/bee` |
