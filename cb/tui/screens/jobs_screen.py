"""Jobs pane -- list jobs, trigger builds."""
from __future__ import annotations
from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import DataTable, Static
from textual.reactive import reactive
from textual import work
from cb.tui.compat import SYM
from cb.tui.widgets.loader import AsciiLoader


def _mk(icon: str, color: str) -> str:
    return f"[{color}]{icon}[/{color}]"


_STATUS = {
    "blue":     _mk(f"{SYM.ok}  OK  ", "green"),
    "red":      _mk(f"{SYM.fail} FAIL", "red"),
    "yellow":   _mk(f"{SYM.warn} WARN", "yellow"),
    "aborted":  _mk(f"{SYM.aborted} ABT ", "dim"),
    "notbuilt": _mk(f"{SYM.notbuilt} NEW ", "dim"),
    "disabled": _mk(f"{SYM.disabled} DIS ", "dim"),
    "":         "[dim]-    [/dim]",
}


def _status(color: str) -> str:
    base = color.replace("_anime", "")
    running = "_anime" in color
    icon = _STATUS.get(base, f"[dim]{base[:5]}[/dim]")
    return icon + (f" {SYM.running}" if running else "")


class JobsPane(Widget):
    """Tab 4: List jobs, run selected job."""

    DEFAULT_CSS = "JobsPane { height: 1fr; }"

    BINDINGS = [
        ("f5",    "refresh", "Refresh"),
        ("r",     "run_job", "Run"),
        ("enter", "run_job", "Run"),
    ]

    _loading: reactive[bool] = reactive(True)
    _error:   reactive[str]  = reactive("")

    def compose(self) -> ComposeResult:
        yield Static("Jobs", classes="panel-title")
        yield AsciiLoader(id="loader")
        yield DataTable(id="jobs-table", cursor_type="row")

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("Type", "Status", "Name", "Build #")
        table.display = False
        self._load_jobs()

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display = not loading

    def watch__error(self, error: str) -> None:
        if error:
            self.query_one(".panel-title", Static).update(
                f"[red]Jobs -- {error}[/red]"
            )

    @work(thread=True, exclusive=True, name="load-jobs")
    def _load_jobs(self) -> None:
        self._loading = True
        self._error = ""
        try:
            client = self.app.ctrl_client or self.app.oc_client
            if not client:
                self._error = "Not logged in."
                return
            from cb.services.job_service import list_jobs
            jobs = list_jobs(client)
            self.app.call_from_thread(self._populate_table, jobs)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, jobs: list) -> None:
        table = self.query_one(DataTable)
        table.clear()
        self.app.bee_jobs = jobs
        for j in jobs:
            table.add_row(
                j.job_type or "??",
                _status(j.color),
                j.name[:40],
                str(j.last_build_number or "-"),
            )

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        client = self.app.ctrl_client or self.app.oc_client
        if client:
            invalidate_prefix("jobs.", self.app._db_path)
        self._load_jobs()

    def action_run_job(self) -> None:
        table = self.query_one(DataTable)
        jobs = getattr(self.app, "_jobs", [])
        if not jobs or table.cursor_row < 0 or table.cursor_row >= len(jobs):
            return
        job = jobs[table.cursor_row]
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Run job '{job.name}'?"),
            lambda confirmed: self._trigger_job(job.name) if confirmed else None,
        )

    @work(thread=True, name="trigger-job")
    def _trigger_job(self, name: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.job_service import trigger_job
            trigger_job(client, name)
            self.app.call_from_thread(
                self.app.notify, f"Triggered: {name}", title="Job Started"
            )
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Trigger Failed", severity="error"
            )
