"""Jobs pane — full feature parity with CLI: list, run, stop, log, create, delete."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Button, DataTable, Static
from textual import work

from cb.tui.compat import SYM
from cb.tui.widgets.loader import AsciiLoader
from cb.tui.widgets.vim_nav import VimNavMixin


def _status_markup(color: str) -> str:
    """Map Jenkins color string to coloured status label."""
    running = "_anime" in color
    base    = color.replace("_anime", "")
    _map = {
        "blue":     f"[green]{SYM.ok}  OK  [/green]",
        "red":      f"[red]{SYM.fail} FAIL[/red]",
        "yellow":   f"[yellow]{SYM.warn} WARN[/yellow]",
        "aborted":  f"[dim]{SYM.aborted} ABT [/dim]",
        "notbuilt": f"[dim]{SYM.notbuilt} NEW [/dim]",
        "disabled": f"[dim]{SYM.disabled} DIS [/dim]",
    }
    icon = _map.get(base, f"[dim]{base[:4]}[/dim]")
    return icon + (f" [yellow]{SYM.running}[/yellow]" if running else "")


def _type_label(job_type: str | None) -> str:
    t = (job_type or "").lower()
    if "pipeline" in t:
        return "[blue]PL[/blue]"
    if "freestyle" in t:
        return "[cyan]FS[/cyan]"
    if "folder" in t:
        return "[yellow]FD[/yellow]"
    if "workflow" in t:
        return "[blue]WF[/blue]"
    return "[dim]--[/dim]"


class JobsPane(VimNavMixin, Widget):
    """Tab 4: Jobs list with create, run, stop, log, delete."""

    DEFAULT_CSS = "JobsPane { height: 1fr; }"

    BINDINGS = [
        ("f5",    "refresh",     "Refresh"),
        ("a",     "toggle_all",  "Mine/All"),
        ("r",     "run_job",     "Run"),
        ("s",     "stop_job",    "Stop"),
        ("l",     "view_log",    "Log"),
        ("n",     "create_job",  "New Job"),
        ("d",     "delete_job",  "Delete"),
        ("enter", "open_detail", "Detail"),
    ]

    _loading:   reactive[bool] = reactive(True)
    _error:     reactive[str]  = reactive("")
    _show_all:  reactive[bool] = reactive(False)

    def compose(self) -> ComposeResult:
        yield Static("", classes="pane-header", id="jobs-header")
        yield Static("", classes="filter-bar", id="jobs-filter")
        yield AsciiLoader(id="loader")
        yield DataTable(id="jobs-table", cursor_type="row", zebra_stripes=True)
        with Vertical(id="detail-panel"):
            yield Static(
                f"[dim]{SYM.arrow} Navigate to a job to see details[/dim]",
                id="detail-panel-content",
            )

    def on_mount(self) -> None:
        t = self.query_one(DataTable)
        t.add_columns("Status", "T", "Name", "Build #", "Description")
        t.display = False
        self._update_header()
        self._load_jobs()

    def on_focus(self) -> None:
        try:
            self.query_one(DataTable).focus()
        except Exception:
            pass

    # ── Reactive watchers ──────────────────────────────────────

    def _update_header(self) -> None:
        self.query_one("#jobs-header", Static).update(
            f" {SYM.gear} Jobs  "
            f"[dim]r=run · s=stop · l=log · n=new · d=del · a=mine/all · F5=refresh[/dim]"
        )
        scope = "[yellow]ALL[/yellow]" if self._show_all else "[green]MINE[/green]"
        self.query_one("#jobs-filter", Static).update(
            f" {SYM.arrow} Scope: {scope}"
        )

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display   = loading
        self.query_one(DataTable).display      = not loading

    def watch__error(self, error: str) -> None:
        hdr = self.query_one("#jobs-header", Static)
        if error:
            hdr.update(f"[red]{SYM.fail} Jobs — {error}[/red]")
        else:
            self._update_header()

    def watch__show_all(self, _: bool) -> None:
        self._update_header()

    # ── Cursor hover → detail panel ───────────────────────────

    def on_data_table_cursor_moved(self, event: DataTable.CursorMoved) -> None:
        jobs = self.app.bee_jobs
        if not jobs or event.cursor_row >= len(jobs):
            return
        j = jobs[event.cursor_row]
        status   = _status_markup(j.color)
        jtype    = j.job_type or "-"
        build    = f"#{j.last_build_number}" if j.last_build_number else "—"
        url_part = f"[dim]{(getattr(j,'url','') or '')[:60]}[/dim]"
        self.query_one("#detail-panel-content", Static).update(
            f"[bold]{j.name}[/bold]   {status}   [dim]type:[/dim] {jtype}   "
            f"[dim]build:[/dim] {build}\n{url_part}"
        )

    # ── Data loading ───────────────────────────────────────────

    @work(thread=True, exclusive=True, name="load-jobs")
    def _load_jobs(self) -> None:
        self._loading = True
        self._error   = ""
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client:
                self._error = "Not logged in — press L"
                self._loading = False
                return
            from cb.services.job_service import list_jobs
            from cb.db.repositories.resource_repo import get_tracked_resources
            import cb.dtos.job as job_dto

            all_jobs = list_jobs(client)

            if not self._show_all:
                profile_name = "default"
                tracked  = get_tracked_resources(
                    "job", profile_name,
                    controller_name=client.base_url,
                    db_path=self.app._db_path,
                )
                tracked_set  = set(tracked)
                display_jobs = [j for j in all_jobs if j.name in tracked_set]
                server_names = {j.name for j in all_jobs}
                for m in tracked_set - server_names:
                    display_jobs.append(
                        job_dto.JobDTO(name=m, url="", color="[DELETED_ON_SERVER]")
                    )
                jobs = display_jobs
            else:
                jobs = all_jobs

            self.app.call_from_thread(self._populate_table, jobs)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, jobs: list) -> None:
        t = self.query_one(DataTable)
        t.clear()
        self.app.bee_jobs = jobs
        for j in jobs:
            t.add_row(
                _status_markup(j.color),
                _type_label(j.job_type),
                j.name[:42],
                str(j.last_build_number or "—"),
                (j.description or "")[:30],
            )

    # ── Row select → push detail screen ───────────────────────

    def action_open_detail(self) -> None:
        """Open detail screen — triggered ONLY by Enter key."""
        t = self.query_one(DataTable)
        jobs = self.app.bee_jobs
        if not jobs or not (0 <= t.cursor_row < len(jobs)):
            return
        job = jobs[t.cursor_row]
        self._open_detail_worker(job)

    @work(thread=True, exclusive=True, name="open-detail")
    def _open_detail_worker(self, job) -> None:
        try:
            client = getattr(self.app, "ctrl_client", None)
            if getattr(self.app, "_username", "") and client:
                from cb.services.job_service import get_job
                detailed_job = get_job(client, job.name)
                if detailed_job:
                    job = detailed_job
                    
            from cb.tui.screens.detail_screen import DetailScreen
            info = [
                ("Name",       job.name),
                ("Status",     job.color),
                ("Type",       job.job_type or "-"),
                ("Last Build", str(job.last_build_number or "—")),
                ("URL",        getattr(job, "url", "") or "-"),
                ("Description", (job.description or "-")[:60]),
            ]
            actions = [
                ("r", f"{SYM.running} Run Build",   lambda j=job: self._confirm_run(j.name)),
                ("s", f"{SYM.fail}  Stop Build",   lambda j=job: self._confirm_stop(j)),
                ("l", f"{SYM.arrow} View Log",      lambda j=job: self._view_log(j.name)),
                ("d", f"{SYM.warn}  Delete Job",    lambda j=job: self._confirm_delete(j.name)),
            ]
            self.app.call_from_thread(
                self.app.push_screen,
                DetailScreen(f"Job: {job.name}", info, actions)
            )
        except Exception as e:
            self.app.call_from_thread(self.app.notify, f"Error: {e}", severity="error")

    # ── Key bindings ───────────────────────────────────────────

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        client = getattr(self.app, "ctrl_client", None)
        if client:
            invalidate_prefix("jobs.", self.app._db_path)
        self._load_jobs()

    def action_toggle_all(self) -> None:
        self._show_all = not self._show_all
        self._load_jobs()

    def action_run_job(self) -> None:
        jobs = self.app.bee_jobs
        row  = self.query_one(DataTable).cursor_row
        if jobs and 0 <= row < len(jobs):
            self._confirm_run(jobs[row].name)

    def action_stop_job(self) -> None:
        jobs = self.app.bee_jobs
        row  = self.query_one(DataTable).cursor_row
        if jobs and 0 <= row < len(jobs):
            self._confirm_stop(jobs[row])

    def action_view_log(self) -> None:
        jobs = self.app.bee_jobs
        row  = self.query_one(DataTable).cursor_row
        if jobs and 0 <= row < len(jobs):
            self._view_log(jobs[row].name)

    def action_create_job(self) -> None:
        from cb.tui.widgets.modals import CreateJobModal
        self.app.push_screen(
            CreateJobModal(),
            lambda result: self._create_job(**result) if result else None,
        )

    def action_delete_job(self) -> None:
        jobs = self.app.bee_jobs
        row  = self.query_one(DataTable).cursor_row
        if jobs and 0 <= row < len(jobs):
            self._confirm_delete(jobs[row].name)

    # ── Confirmations / workers ────────────────────────────────

    def _confirm_run(self, name: str) -> None:
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Run job '{name}'?"),
            lambda ok: self._do_run(name) if ok else None,
        )

    def _confirm_stop(self, job) -> None:
        build_num = job.last_build_number
        if not build_num:
            self.app.notify("No builds found to stop.", severity="warning")
            return
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Stop build #{build_num} of '{job.name}'?"),
            lambda ok: self._do_stop(job.name, build_num) if ok else None,
        )

    def _confirm_delete(self, name: str) -> None:
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Delete job '{name}'? This cannot be undone."),
            lambda ok: self._do_delete(name) if ok else None,
        )

    def _view_log(self, name: str) -> None:
        from cb.tui.screens.log_screen import LogScreen
        self.app.push_screen(LogScreen(name))

    @work(thread=True, name="run-job")
    def _do_run(self, name: str) -> None:
        self.app.call_from_thread(self.app.notify, f"Starting job: {name}...", title="Run")
        client = getattr(self.app, "ctrl_client", None)
        if not client: return
        try:
            from cb.services.job_service import trigger_job
            trigger_job(client, name)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Triggered: [bold]{name}[/bold]",
                title="Job Started",
            )
            self._load_jobs()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Trigger Failed", severity="error"
            )

    @work(thread=True, name="stop-job")
    def _do_stop(self, name: str, build_num: int) -> None:
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client: return
            from cb.services.job_service import stop_build
            stop_build(client, name, build_num)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Stopped build #{build_num} of [bold]{name}[/bold]",
                title="Build Stopped",
            )
            self._load_jobs()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Stop Failed", severity="error"
            )

    @work(thread=True, name="delete-job")
    def _do_delete(self, name: str) -> None:
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client: return
            from cb.services.job_service import delete_job
            delete_job(client, name)
            from cb.db.repositories.resource_repo import untrack_resource
            profile = "default"
            untrack_resource("job", name, profile,
                             controller_name=client.base_url,
                             db_path=self.app._db_path)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Deleted: [bold]{name}[/bold]",
                title="Job Deleted",
            )
            self._load_jobs()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Delete Failed", severity="error"
            )

    @work(thread=True, name="create-job")
    def _create_job(self, name: str, job_type: str, desc: str = "",
                    shell_cmd: str = "", script: str = "") -> None:
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client: return
            from cb.services.job_service import (
                create_freestyle_job, create_pipeline_job, create_folder
            )
            if job_type == "freestyle":
                create_freestyle_job(client, name, desc=desc,
                                     shell_cmd=shell_cmd or "echo hello")
            elif job_type == "pipeline":
                create_pipeline_job(client, name, desc=desc, script=script)
            elif job_type == "folder":
                create_folder(client, name, desc=desc)

            from cb.db.repositories.resource_repo import track_resource
            profile = "default"
            track_resource("job", name, profile,
                           controller_name=client.base_url,
                           db_path=self.app._db_path)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Created {job_type}: [bold]{name}[/bold]",
                title="Job Created",
            )
            self._load_jobs()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Create Failed", severity="error"
            )
