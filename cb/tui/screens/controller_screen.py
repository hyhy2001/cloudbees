"""Controller pane -- list and select CloudBees controllers."""
from __future__ import annotations
from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import DataTable, Static
from textual.reactive import reactive
from textual import work
from cb.tui.widgets.loader import AsciiLoader


class ControllerPane(Widget):
    """Tab 1: List all controllers, select one to activate."""

    DEFAULT_CSS = "ControllerPane { height: 1fr; }"

    BINDINGS = [
        ("f5", "refresh", "Refresh"),
        ("enter", "select_controller", "Select"),
    ]

    _loading: reactive[bool] = reactive(True)
    _error:   reactive[str]  = reactive("")

    def compose(self) -> ComposeResult:
        yield Static("Controllers", classes="panel-title")
        yield AsciiLoader(id="loader")
        yield DataTable(id="ctrl-table", cursor_type="row")

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("Name", "Online", "Type", "URL")
        table.display = False
        self._load_controllers()

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display = not loading

    def watch__error(self, error: str) -> None:
        if error:
            self.query_one(".panel-title", Static).update(
                f"[red]Controllers -- {error}[/red]"
            )

    @work(thread=True, exclusive=True, name="load-controllers")
    def _load_controllers(self) -> None:
        self._loading = True
        self._error = ""
        try:
            oc_client = self.app.oc_client
            if not oc_client:
                self._error = "Not logged in. Press L to login."
                return
            from cb.services.controller_service import list_controllers
            controllers = list_controllers(oc_client)
            self.app.call_from_thread(self._populate_table, controllers)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, controllers: list) -> None:
        table = self.query_one(DataTable)
        table.clear()
        self.app._controllers = controllers
        for c in controllers:
            status = "[green]YES[/green]" if c.online else "[red]NO[/red]"
            table.add_row(
                c.name, status,
                c.class_name.split(".")[-1][:20],
                (c.url or "")[:50],
            )

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("controllers.", self.app._db_path)
        self._load_controllers()

    def action_select_controller(self) -> None:
        table = self.query_one(DataTable)
        controllers = getattr(self.app, "_controllers", [])
        if not controllers or table.cursor_row < 0 or table.cursor_row >= len(controllers):
            return
        self._select(controllers[table.cursor_row])

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        controllers = getattr(self.app, "_controllers", [])
        if controllers and event.cursor_row < len(controllers):
            self._select(controllers[event.cursor_row])

    @work(thread=True, name="select-controller")
    def _select(self, ctrl) -> None:
        from cb.api.client import CloudBeesClient
        from cb.services.controller_service import select_controller
        oc = self.app.oc_client
        if not oc:
            return
        true_url = oc.resolve_redirect(ctrl.url) if ctrl.url else ctrl.url
        if not true_url:
            true_url = ctrl.url
        select_controller(ctrl.name, true_url or "", self.app._db_path)
        self.app.call_from_thread(setattr, self.app, "active_ctrl_name", ctrl.name)
        if true_url:
            new_client = CloudBeesClient(
                base_url=true_url.rstrip("/"),
                token=oc._token,
                db_path=self.app._db_path,
            )
            self.app.call_from_thread(setattr, self.app, "ctrl_client", new_client)
        self.app.call_from_thread(
            self.app.notify, f"Active controller: {ctrl.name}", title="Controller Selected"
        )
        try:
            from cb.services.controller_service import get_controller_capabilities
            caps = get_controller_capabilities(oc, ctrl.name)
            rows = [
                ("Status",      "ONLINE" if caps.online else "OFFLINE"),
                ("Type",        caps.type_label),
                ("URL",         (caps.url or "")[:50]),
                ("",            ""),
                ("Create Job",  "YES" if caps.can_create_job  else "NO"),
                ("Create Node", "YES" if caps.can_create_node else "NO"),
                ("Create Cred", "YES" if caps.can_create_cred else "NO"),
            ]
            from cb.tui.widgets.modals import InfoModal
            self.app.call_from_thread(
                self.app.push_screen, InfoModal(f"Controller: {ctrl.name}", rows)
            )
        except Exception:
            pass
