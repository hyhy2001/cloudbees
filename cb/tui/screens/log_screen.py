"""Log screen — stream or display build console log."""
from __future__ import annotations

from textual.binding import Binding
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Footer, Header, RichLog, Static
from textual import work

from cb.tui.compat import SYM


class LogScreen(Screen):
    """Full-screen build log viewer for a job.

    Shows the last build log; press F5 to refresh.
    Press Esc/q to return to the Jobs tab.
    """

    BINDINGS = [
        ("escape", "go_back",    "Back"),
        ("q",      "go_back",    "Back"),
        ("f5",     "refresh_log","Refresh"),
        ("b",      "go_back",    "Back"),
        Binding("j",      "scroll_down", "", show=False),
        Binding("k",      "scroll_up",   "", show=False),
        Binding("g",      "scroll_top",  "", show=False),
        Binding("G",      "scroll_end",  "", show=False),
        Binding("ctrl+f", "page_down",   "", show=False),
        Binding("ctrl+b", "page_up",     "", show=False),
    ]

    def __init__(self, job_name: str, build_number: int | None = None, **kwargs):
        super().__init__(**kwargs)
        self._job_name    = job_name
        self._build_number = build_number

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Vertical():
            yield Static(
                f" {SYM.arrow} Log: [bold]{self._job_name}[/bold]  "
                f"[dim]q/Esc=back · F5=refresh[/dim]",
                id="log-header",
            )
            yield RichLog(id="log-view", highlight=True, markup=True, wrap=True)
        yield Footer()

    def on_mount(self) -> None:
        self._fetch_log()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    def action_refresh_log(self) -> None:
        log_view = self.query_one("#log-view", RichLog)
        log_view.clear()
        self._fetch_log()

    # ── Vim scroll actions ──────────────────────────────────────

    def action_scroll_down(self) -> None:
        self.query_one("#log-view", RichLog).scroll_down()

    def action_scroll_up(self) -> None:
        self.query_one("#log-view", RichLog).scroll_up()

    def action_scroll_top(self) -> None:
        self.query_one("#log-view", RichLog).scroll_home()

    def action_scroll_end(self) -> None:
        self.query_one("#log-view", RichLog).scroll_end()

    def action_page_down(self) -> None:
        log = self.query_one("#log-view", RichLog)
        log.scroll_page_down()

    def action_page_up(self) -> None:
        log = self.query_one("#log-view", RichLog)
        log.scroll_page_up()

    @work(thread=True, name="fetch-log")
    def _fetch_log(self) -> None:
        log_view = self.query_one("#log-view", RichLog)
        try:
            client = self.app.ctrl_client or self.app.oc_client
            if not client:
                self.app.call_from_thread(
                    log_view.write,
                    f"[red]{SYM.fail} Not logged in.[/red]"
                )
                return

            from cb.services.job_service import get_last_build_log, get_build_log

            self.app.call_from_thread(
                log_view.write,
                f"[dim]Fetching log for [bold]{self._job_name}[/bold]...[/dim]"
            )

            if self._build_number:
                text = get_build_log(client, self._job_name, self._build_number)
            else:
                text = get_last_build_log(client, self._job_name)

            self.app.call_from_thread(log_view.clear)

            if not text or text.strip() == "(No builds found)":
                self.app.call_from_thread(
                    log_view.write,
                    f"[yellow]{SYM.warn} No build log found for '{self._job_name}'.[/yellow]"
                )
                return

            # Write log lines with colour-coding
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped:
                    self.app.call_from_thread(log_view.write, "")
                    continue
                # Colour-code common log patterns
                if any(k in stripped.upper() for k in ("ERROR", "FAILED", "FAILURE", "EXCEPTION")):
                    self.app.call_from_thread(log_view.write, f"[red]{line}[/red]")
                elif any(k in stripped.upper() for k in ("WARN", "WARNING")):
                    self.app.call_from_thread(log_view.write, f"[yellow]{line}[/yellow]")
                elif any(k in stripped.upper() for k in ("SUCCESS", "FINISHED", "COMPLETED")):
                    self.app.call_from_thread(log_view.write, f"[green]{line}[/green]")
                elif stripped.startswith("[Pipeline]") or stripped.startswith("+ "):
                    self.app.call_from_thread(log_view.write, f"[blue]{line}[/blue]")
                else:
                    self.app.call_from_thread(log_view.write, line)

        except Exception as exc:
            self.app.call_from_thread(
                log_view.write,
                f"[red]{SYM.fail} Error fetching log: {exc}[/red]"
            )
