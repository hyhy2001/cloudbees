"""Settings pane — system health, version, CLI info, cache management."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widget import Widget
from textual.widgets import Button, Static
from textual.containers import Horizontal
from textual import work

from cb.tui.compat import SYM


class SettingsPane(Widget):
    """Tab 5: System info, health, cache management."""

    DEFAULT_CSS = "SettingsPane { height: 1fr; padding: 0; }"

    BINDINGS = [
        ("f5", "refresh",     "Refresh"),
        ("c",  "clear_cache", "Clear Cache"),
    ]

    def compose(self) -> ComposeResult:
        yield Static(
            f" {SYM.gear} Settings / System Info  "
            f"[dim]F5=refresh · c=clear cache[/dim]",
            classes="pane-header",
        )
        with Vertical():
            yield Static("Loading...", id="sys-info")
            with Horizontal(id="detail-actions"):
                yield Button(
                    f"{SYM.arrow} Clear Cache",
                    id="btn-clear-cache",
                    variant="default",
                )
                yield Button(
                    f"{SYM.running} Refresh Info",
                    id="btn-refresh",
                    variant="primary",
                )

    def on_mount(self) -> None:
        self._load_info()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-clear-cache":
            self.action_clear_cache()
        elif event.button.id == "btn-refresh":
            self.action_refresh()

    def action_refresh(self) -> None:
        self._load_info()

    def action_clear_cache(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("", self.app._db_path)  # clears everything
        self.app.notify(
            f"{SYM.ok} Cache cleared. F5 to reload fresh data.",
            title="Cache Cleared",
        )
        self._load_info()

    @work(thread=True, exclusive=True, name="load-settings")
    def _load_info(self) -> None:
        try:
            client = self.app.oc_client
            if not client:
                self.app.call_from_thread(
                    self.query_one("#sys-info", Static).update,
                    f"[yellow]{SYM.warn} Not logged in — press L to login.[/yellow]",
                )
                return

            from cb.services.system_service import health_check, get_version
            version  = get_version(client)
            health   = health_check(client)

            from cb import main as _main
            import time

            lines = [
                f"\n[bold blue]CloudBees CI[/bold blue]",
                f"  [dim]Version      :[/dim]  [bold]{version}[/bold]",
            ]
            for k, v in health.items():
                col = "green" if str(v).lower() in ("ok", "true", "1") else "yellow"
                lines.append(f"  [dim]{k:<12}:[/dim]  [{col}]{v}[/{col}]")

            active   = self.app.active_ctrl_name or "[dim]none selected[/dim]"
            username = self.app._username or "[dim]not set[/dim]"
            db_path  = str(self.app._db_path or "data/cb.db")

            lines += [
                "",
                f"[bold blue]bee CLI[/bold blue]",
                f"  [dim]CLI Version  :[/dim]  [bold]{_main.__version__}[/bold]",
                f"  [dim]User         :[/dim]  [bold]{username}[/bold]",
                f"  [dim]Controller   :[/dim]  [bold]{active}[/bold]",
                f"  [dim]Database     :[/dim]  [bold]{db_path}[/bold]",
                f"  [dim]Unicode Mode :[/dim]  "
                f"{'[green]ON[/green]' if SYM.ok == '✓' else '[dim]OFF (ASCII)[/dim]'}",
                "",
                f"[dim]Press [bold]c[/bold] to clear cache  ·  F5 to refresh  ·  q to quit[/dim]",
            ]

            self.app.call_from_thread(
                self.query_one("#sys-info", Static).update,
                "\n".join(lines),
            )
        except Exception as exc:
            self.app.call_from_thread(
                self.query_one("#sys-info", Static).update,
                f"[red]{SYM.fail} Error: {exc}[/red]",
            )
