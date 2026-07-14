# JSON output

Pass the global `--json` flag to make `bee` emit machine-readable JSON instead of formatted text. It works with any command, in any position:

```bash
bee --json node list
bee node list --json
```

Use it for scripts, wrappers, or agent tooling that needs to parse `bee`'s output.

## What you get

- **Read commands** (`list`, `get`, `info`, `current`, `profiles`) return the underlying data as a JSON array or object.
- **Single-item mutations** (`create`, `update`, `select`, `login`, …) return a status object such as `{ "ok": true, "name": "my-job", "url": "…" }`.
- **Batch mutations** over multiple names (`delete`, `track`, `untrack`) return `{ "results": [ … ] }` with one entry per item, so a partial failure is still parseable.

Errors are written to **stderr** as `{ "error": "…" }` and the process exits non-zero — so a script can branch on exit code and still read the message.

```bash
bee --json controller current              # → null when none selected
bee auth profiles --json | jq '.[].name'   # pipe straight into jq
```

## Non-interactive rules

JSON mode never prompts, because a prompt would corrupt stdout and hang a script. Two consequences:

- **Destructive commands require `--yes`.** Without it, `bee` emits `{ "error": "--yes is required …" }` and exits non-zero instead of asking for confirmation.

  ```bash
  bee --json job delete my-job --yes
  ```

- **Commands that would prompt for input require the values as flags.** For example `bee login` must be given `--url`, `--username`, and `--token`; `bee cred create` (Username+Password) must be given `--password`.

The global `--json` flag is the single, consistent way to get JSON from any
command. (Earlier builds had a local `-o json` / `--output` flag on `bee cred
list`; it has been removed in favor of `--json`.)
