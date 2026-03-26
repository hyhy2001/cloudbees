"""Settings screen — system health + version info."""
from __future__ import annotations
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Footer, Static
from textual.containers import Vertical
from textual import work


class SettingsScreen(Screen):
    """Screen 5: System info, health check, version."""

    BINDINGS = [("f5", "refresh", "Refresh")]

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("[bold blue]⚙  Settings / System Info[/bold blue]\n")
            yield Static("Loading...", id="sys-info")
        yield Footer()

    def on_mount(self) -> None:
        self._load_info()

    def action_refresh(self) -> None:
        self._load_info()

    @work(thread=True, exclusive=True, name="load-settings")
    def _load_info(self) -> None:
        try:
            client = self.app.oc_client
            if not client:
                self.app.call_from_thread(
                    self.query_one("#sys-info", Static).update,
                    "[yellow]Not logged in. Press L to login.[/yellow]"
                )
                return
            from cb.services.system_service import health_check, get_version
            version = get_version(client)
            info = health_check(client)

            lines = [f"[dim]Version   :[/dim] [bold]{version}[/bold]"]
            for k, v in info.items():
                lines.append(f"[dim]{k:<12}:[/dim] [bold]{v}[/bold]")

            # App-level info
            from cb import main as _main
            lines += [
                "",
                f"[dim]bee CLI   :[/dim] [bold]{_main.__version__}[/bold]",
                f"[dim]DB path   :[/dim] [bold]{self.app._db_path or 'default'}[/bold]",
                f"[dim]Controller:[/dim] [bold]{self.app.active_ctrl_name or 'none'}[/bold]",
            ]

            self.app.call_from_thread(
                self.query_one("#sys-info", Static).update,
                "\n".join(lines)
            )
        except Exception as exc:
            self.app.call_from_thread(
                self.query_one("#sys-info", Static).update,
                f"[red]Error: {exc}[/red]"
            )
