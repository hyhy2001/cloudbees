"""Controller pane — list controllers, select active, show capabilities."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import DataTable, Static
from textual import work

from cb.tui.compat import SYM
from cb.tui.widgets.loader import AsciiLoader
from cb.tui.widgets.vim_nav import VimNavMixin


def _online_markup(online: bool) -> str:
    if online:
        return f"[green]{SYM.online} ONLINE[/green]"
    return f"[red]{SYM.offline} OFFLINE[/red]"


class ControllerPane(VimNavMixin, Widget):
    """Tab 1: List all controllers. Enter → detail + select."""

    DEFAULT_CSS = "ControllerPane { height: 1fr; }"

    BINDINGS = [
        ("f5",    "refresh",     "Refresh"),
        ("enter", "open_detail", "Detail"),
        ("s",     "select_controller", "Select"),
    ]

    _loading: reactive[bool] = reactive(True)
    _error:   reactive[str]  = reactive("")
    _selected_row: reactive[int] = reactive(-1)

    def compose(self) -> ComposeResult:
        yield Static(
            f" {SYM.gear} Controllers  "
            f"[dim]Enter=select · F5=refresh[/dim]",
            classes="pane-header",
        )
        yield AsciiLoader(id="loader")
        yield DataTable(id="ctrl-table", cursor_type="row", zebra_stripes=True)
        with Vertical(id="detail-panel"):
            yield Static(
                f"[dim]{SYM.arrow} Select a controller to see details[/dim]",
                id="detail-panel-content",
            )

    def on_mount(self) -> None:
        t = self.query_one(DataTable)
        t.add_columns("  ", "Name", "Type", "URL")
        t.display = False
        self._load_controllers()

    def on_focus(self) -> None:
        try:
            self.query_one(DataTable).focus()
        except Exception:
            pass

    # ── Reactive watchers ──────────────────────────────────────

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display   = not loading

    def watch__error(self, error: str) -> None:
        hdr = self.query_one(".pane-header", Static)
        if error:
            hdr.update(f"[red]{SYM.fail} Controllers — {error}[/red]")
        else:
            hdr.update(
                f" {SYM.gear} Controllers  "
                f"[dim]Enter=select · F5=refresh[/dim]"
            )

    # ── Data loading ───────────────────────────────────────────

    @work(thread=True, exclusive=True, name="load-controllers")
    def _load_controllers(self) -> None:
        self._loading = True
        self._error   = ""
        try:
            oc = self.app.oc_client
            if not oc:
                self._error = "Not logged in — press L"
                return
            from cb.services.controller_service import list_controllers
            controllers = list_controllers(oc)
            self.app.call_from_thread(self._populate_table, controllers)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, controllers: list) -> None:
        t = self.query_one(DataTable)
        t.clear()
        self.app.bee_controllers = controllers
        active = self.app.active_ctrl_name
        for c in controllers:
            indicator = (
                f"[yellow]{SYM.selected}[/yellow]" if c.name == active else " "
            )
            t.add_row(
                indicator,
                c.name,
                c.class_name.split(".")[-1][:18],
                (c.url or "")[:48],
            )

    # ── Cursor movement → update detail panel ─────────────────

    def on_data_table_cursor_moved(self, event: DataTable.CursorMoved) -> None:
        self._update_detail(event.cursor_row)

    def _update_detail(self, row: int) -> None:
        controllers = self.app.bee_controllers
        if not controllers or row < 0 or row >= len(controllers):
            return
        c = controllers[row]
        active = self.app.active_ctrl_name
        status = _online_markup(c.online)
        is_active = f"[yellow]{SYM.selected} ACTIVE[/yellow]" if c.name == active else "[dim]not active[/dim]"
        self.query_one("#detail-panel-content", Static).update(
            f"[bold]{c.name}[/bold]   {status}   {is_active}\n"
            f"[dim]Type:[/dim] {c.class_name.split('.')[-1]}   "
            f"[dim]URL:[/dim] {c.url or '-'}"
        )

    # ── Row selected → Enter → detail + select action ─────────

    def action_open_detail(self) -> None:
        """Open detail screen — triggered ONLY by Enter key."""
        t = self.query_one(DataTable)
        controllers = self.app.bee_controllers
        if not controllers or not (0 <= t.cursor_row < len(controllers)):
            return
        ctrl = controllers[t.cursor_row]
        from cb.tui.screens.detail_screen import DetailScreen
        info = [
            ("Name",   ctrl.name),
            ("Status", "ONLINE" if ctrl.online else "OFFLINE"),
            ("Type",   ctrl.class_name.split(".")[-1]),
            ("URL",    ctrl.url or ""),
        ]
        actions = [
            ("s", f"Select '{ctrl.name}' as Active", lambda c=ctrl: self._select(c)),
        ]
        self.app.push_screen(DetailScreen(f"Controller: {ctrl.name}", info, actions))

    def action_select_controller(self) -> None:
        t = self.query_one(DataTable)
        controllers = self.app.bee_controllers
        if controllers and 0 <= t.cursor_row < len(controllers):
            self._select(controllers[t.cursor_row])

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("controllers.", self.app._db_path)
        self._load_controllers()

    # ── Select controller ─────────────────────────────────────

    @work(thread=True, name="select-controller")
    def _select(self, ctrl) -> None:
        from cb.api.client import CloudBeesClient
        from cb.services.controller_service import select_controller, resolve_controller_url

        oc = self.app.oc_client
        if not oc:
            return

        # Use the same resolve logic as CLI: follow 302 + strip SSO suffix
        true_url = resolve_controller_url(oc, ctrl.url)

        select_controller(ctrl.name, true_url, self.app._db_path)
        self.app.call_from_thread(setattr, self.app, "active_ctrl_name", ctrl.name)

        if true_url:
            new_client = CloudBeesClient(
                base_url=true_url.rstrip("/"),
                token=oc._token,
                db_path=self.app._db_path,
            )
            self.app.call_from_thread(setattr, self.app, "ctrl_client", new_client)

        self.app.call_from_thread(
            self.app.notify,
            f"{SYM.ok} Active controller: [bold]{ctrl.name}[/bold]",
            title="Controller Selected",
        )
        self.app.call_from_thread(self.app._refresh_all_panes)
