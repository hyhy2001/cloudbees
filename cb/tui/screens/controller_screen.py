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

    PANE_TITLE = "Controllers  (Enter=select)"
    DEFAULT_CSS = "ControllerPane { height: 1fr; }"

    BINDINGS = [("f5", "refresh", "Refresh")]

    _loading: reactive[bool] = reactive(True)
    _error:   reactive[str]  = reactive("")

    def compose(self) -> ComposeResult:
        yield Static(self.PANE_TITLE, classes="panel-title")
        yield AsciiLoader(id="loader")
        yield DataTable(id="ctrl-table", cursor_type="row", zebra_stripes=True)

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("Name", "Online", "Type", "URL")
        table.display = False
        self._load_controllers()

    def on_focus(self) -> None:
        """Focus DataTable when pane gains focus."""
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
            title.update(self.PANE_TITLE)

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
        self.app.bee_controllers = controllers
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

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        controllers = self.app.bee_controllers
        if not controllers or event.cursor_row >= len(controllers):
            return
        ctrl = controllers[event.cursor_row]
        from cb.tui.screens.detail_screen import DetailScreen
        info = [
            ("Name",   ctrl.name),
            ("Status", "ONLINE" if ctrl.online else "OFFLINE"),
            ("Type",   ctrl.class_name.split(".")[-1]),
            ("URL",    ctrl.url or ""),
        ]
        actions = [
            ("s", "Select as Active", lambda c=ctrl: self._select(c)),
        ]
        self.app.push_screen(DetailScreen(f"Controller: {ctrl.name}", info, actions))

    @work(thread=True, name="select-controller")
    def _select(self, ctrl) -> None:
        from cb.api.client import CloudBeesClient
        from cb.services.controller_service import select_controller
        oc = self.app.oc_client
        if not oc:
            return
        true_url = ctrl.url
        try:
            resolved = oc.resolve_redirect(ctrl.url)
            if resolved:
                true_url = resolved
        except Exception:
            pass
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
            self.app.notify,
            f"Active controller: {ctrl.name}",
            title="Controller Selected",
        )
        # Refresh other panes with new controller client
        self.app.call_from_thread(self.app._refresh_all_panes)
