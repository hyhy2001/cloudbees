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
        self._log_offset = 0
        self._is_streaming = False
        self._poll_timer = None

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
        self._start_stream()

    def action_go_back(self) -> None:
        if self._poll_timer:
            self._poll_timer.stop()
        self.app.pop_screen()

    def action_refresh_log(self) -> None:
        if self._poll_timer:
            self._poll_timer.stop()
        log_view = self.query_one("#log-view", RichLog)
        log_view.clear()
        self._log_offset = 0
        self._is_streaming = False
        self._start_stream()

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

    @work(thread=True, name="fetch-log", exclusive=True)
    def _start_stream(self) -> None:
        log_view = self.query_one("#log-view", RichLog)
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client:
                self.app.call_from_thread(
                    log_view.write,
                    f"[red]{SYM.fail} Not logged in.[/red]"
                )
                return

            self.app.call_from_thread(
                log_view.write,
                f"[dim]Streaming log for [bold]{self._job_name}[/bold]...[/dim]\n"
            )

            # Do an initial synchronous poll
            self._poll_log()
            
            if self._is_streaming:
                self.app.call_from_thread(self._schedule_poll)

        except Exception as exc:
            self.app.call_from_thread(
                log_view.write,
                f"[red]{SYM.fail} Error starting stream: {exc}[/red]"
            )

    def _schedule_poll(self) -> None:
        """Schedule the next poll iteration."""
        if self._poll_timer:
            self._poll_timer.stop()
        self._poll_timer = self.set_timer(2.0, self._poll_log_worker)

    @work(thread=True, name="poll-log", exclusive=True)
    def _poll_log_worker(self) -> None:
        """Background worker that executes the progressive fetch."""
        self._poll_log()
        if self._is_streaming:
            self.app.call_from_thread(self._schedule_poll)
        else:
            self.app.call_from_thread(
                self.query_one("#log-view", RichLog).write,
                f"\n[dim]{SYM.ok} Stream finished.[/dim]"
            )

    def _poll_log(self) -> None:
        log_view = self.query_one("#log-view", RichLog)
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client: return

            from cb.services.job_service import stream_build_log, stream_last_build_log

            if self._build_number:
                text, new_offset, has_more = stream_build_log(client, self._job_name, self._build_number, self._log_offset)
            else:
                text, new_offset, has_more = stream_last_build_log(client, self._job_name, self._log_offset)

            self._is_streaming = has_more
            self._log_offset = new_offset

            if text:
                self._write_lines(text, log_view)

            if not has_more and self._log_offset == 0 and not text:
                self.app.call_from_thread(
                    log_view.write,
                    f"[yellow]{SYM.warn} No build log found for '{self._job_name}'.[/yellow]"
                )

        except Exception as exc:
            self._is_streaming = False
            self.app.call_from_thread(
                log_view.write,
                f"[red]{SYM.fail} Error fetching log: {exc}[/red]"
            )

    def _write_lines(self, text: str, log_view: RichLog) -> None:
        """Color code and write log chunks to UI."""
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                self.app.call_from_thread(log_view.write, "")
                continue
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
