# bee — Documentation

`bee` is a command-line tool and interactive terminal UI for operating CloudBees CI / Jenkins. One binary, no runtime required.

## Contents

| Doc | What it covers |
|---|---|
| [Getting Started](getting-started.md) | Install, first login, first workflow |
| **Concepts** | |
| [Profiles](concepts/profiles.md) | Saved login targets, switching |
| [Controllers](concepts/controllers.md) | Selecting the active Jenkins master |
| [Mine vs All](concepts/mine-vs-all.md) | Tracked resources |
| [Cache](concepts/cache.md) | Response caching and TTLs |
| [JSON output](concepts/json-output.md) | Machine-readable output with `--json` |
| [Where data lives](concepts/data-location.md) | Database location and security |
| **CLI Reference** | |
| [auth](cli/auth.md) | Login, profiles, logout |
| [controller](cli/controller.md) | Discover and select a controller |
| [job](cli/job.md) | Full job lifecycle |
| [node](cli/node.md) | Agent node lifecycle |
| [cred](cli/cred.md) | Credentials lifecycle |
| [ask](cli/ask.md) | Fuzzy command search |
| **TUI Reference** | |
| [TUI Guide](tui.md) | Interactive UI — layout, tabs, keys |
| **Troubleshooting** | |
| [Auth errors](troubleshooting/auth.md) | Login failed, 401, 403 |
| [Connection errors](troubleshooting/connection.md) | Server unreachable, TLS |
| [Jobs & builds](troubleshooting/jobs.md) | Tracked resources, build logs |
| [TUI issues](troubleshooting/tui.md) | Garbled display, ASCII mode |
| [Environment Variables](env-vars.md) | All env vars bee reads |

## Quick start

```bash
bee auth login                        # prompts URL, username, API token
bee controller list
bee controller select <name>
bee job list
bee --ui                              # launch the interactive TUI
```

Need help finding a command or quick explanation?

```bash
bee ask "create a job"
bee ask "SSH node"
bee ask "switch profile"
bee ask "switch profile" --json
```
