"""Jobs pane -- list jobs, trigger builds, view status.

Default: shows all jobs. Press M to filter to jobs the user has run.
Enter on a job row -> detail screen with Run/Stop/Logs actions.
"""
from __future__ import annotations
from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import DataTable, Static
from textual.reactive import reactive
from textual import work
from cb.tui.compat import SYM
from cb.tui.widgets.loader import AsciiLoader


def _status_markup(color: str) -> str:
    """Map Jenkins color to ASCII status display."""
    running = "_anime" in color
    base = color.replace("_anime", "")
    _map = {
        "blue":     f"[green]{SYM.ok}  OK  [/green]",
        "red":      f"[red]{SYM.fail} FAIL[/red]",
        "yellow":   f"[yellow]{SYM.warn} WARN[/yellow]",
        "aborted":  f"[dim]{SYM.aborted} ABT [/dim]",
        "notbuilt": f"[dim]{SYM.notbuilt} NEW [/dim]",
        "disabled": f"[dim]{SYM.disabled} DIS [/dim]",
    }
    icon = _map.get(base, f"[dim]{base[:5]}[/dim]")
    return icon + (f" {SYM.running}" if running else "")


class JobsPane(Widget):
    """Tab 4: Jobs list. Enter for detail + run/stop/logs actions."""

    PANE_TITLE = "Jobs  (Enter=detail)"
    DEFAULT_CSS = "JobsPane { height: 1fr; }"

    BINDINGS = [
        ("f5", "refresh", "Refresh"),
        ("a",  "toggle_all", "Mine/All"),
        ("r",  "run_job", "Run"),
    ]

    _loading: reactive[bool] = reactive(True)
    _error:   reactive[str]  = reactive("")
    _show_all: reactive[bool] = reactive(False)

    def compose(self) -> ComposeResult:
        yield Static(self.PANE_TITLE, classes="panel-title")
        yield AsciiLoader(id="loader")
        yield DataTable(id="jobs-table", cursor_type="row", zebra_stripes=True)

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("Status", "Name", "Type", "Build #")
        table.display = False
        self._load_jobs()

    def on_focus(self) -> None:
        try:
            self.query_one(DataTable).focus()
        except Exception:
            pass

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display = not loading

    def watch__error(self, error: str) -> None:
        title = self.query_one(".panel-title", Static)
        if error:
            title.update(f"[red]{self.PANE_TITLE} -- {error}[/red]")
        else:
            self.watch__show_all(self._show_all)

    def watch__show_all(self, show: bool) -> None:
        suffix = "  [yellow](all)[/yellow]" if show else "  [green](mine)[/green]"
        self.query_one(".panel-title", Static).update(f"{self.PANE_TITLE}{suffix}")

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
            from cb.db.repositories.resource_repo import get_tracked_resources
            import cb.dtos.job as job_dto

            all_jobs = list_jobs(client)
            if not self._show_all:
                profile_name = getattr(self.app, "_username", "") or "default"
                tracked = get_tracked_resources("job", profile_name, controller_name=client.base_url, db_path=self.app._db_path)
                tracked_set = set(tracked)

                display_jobs = [j for j in all_jobs if j.name in tracked_set]
                server_names = {j.name for j in all_jobs}
                
                missing = tracked_set - server_names
                for m in list(missing):
                    display_jobs.append(job_dto.JobDTO(name=m, url="", color="[DELETED_ON_SERVER]"))
                    
                jobs = display_jobs
            else:
                jobs = all_jobs

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
                _status_markup(j.color),
                j.name[:40],
                j.job_type or "-",
                str(j.last_build_number or "-"),
            )

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        jobs = self.app.bee_jobs
        if not jobs or event.cursor_row >= len(jobs):
            return
        job = jobs[event.cursor_row]
        from cb.tui.screens.detail_screen import DetailScreen
        info = [
            ("Name",       job.name),
            ("Status",     job.color),
            ("Type",       job.job_type or "-"),
            ("Last Build", str(job.last_build_number or "-")),
            ("URL",        getattr(job, "url", "") or "-"),
        ]
        actions = [
            ("r", "Run Build",  lambda j=job: self._confirm_run(j.name)),
        ]
        self.app.push_screen(DetailScreen(f"Job: {job.name}", info, actions))

    def _confirm_run(self, name: str) -> None:
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Run job '{name}'?"),
            lambda confirmed: self._trigger_job(name) if confirmed else None,
        )

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        client = self.app.ctrl_client or self.app.oc_client
        if client:
            invalidate_prefix("jobs.", self.app._db_path)
        self._load_jobs()

    def action_toggle_all(self) -> None:
        self._show_all = not self._show_all
        self._load_jobs()

    def action_run_job(self) -> None:
        table = self.query_one(DataTable)
        jobs = self.app.bee_jobs
        if not jobs or table.cursor_row < 0 or table.cursor_row >= len(jobs):
            return
        self._confirm_run(jobs[table.cursor_row].name)

    @work(thread=True, name="trigger-job")
    def _trigger_job(self, name: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.job_service import trigger_job
            trigger_job(client, name)
            self.app.call_from_thread(
                self.app.notify, f"Triggered: {name}", title="Job Started"
            )
            self._load_jobs()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Trigger Failed", severity="error"
            )
