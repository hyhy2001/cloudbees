"""Nodes screen — list agents, toggle offline/online."""
from __future__ import annotations
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import DataTable, Footer, LoadingIndicator, Static
from textual.reactive import reactive
from textual import work


class NodesScreen(Screen):
    """Screen 3: List agent nodes; toggle offline status."""

    BINDINGS = [
        ("f5", "refresh", "Refresh"),
        ("o", "toggle_offline", "Toggle Offline"),
        ("enter", "toggle_offline", "Toggle"),
    ]

    _loading: reactive[bool] = reactive(True)
    _error: reactive[str] = reactive("")

    def compose(self) -> ComposeResult:
        yield Static("Nodes / Agents", classes="panel-title")
        yield LoadingIndicator()
        yield DataTable(id="nodes-table", cursor_type="row")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("Name", "Status", "Executors", "Labels")
        table.display = False
        self._load_nodes()

    def watch__loading(self, loading: bool) -> None:
        self.query_one(LoadingIndicator).display = loading
        self.query_one(DataTable).display = not loading

    def watch__error(self, error: str) -> None:
        if error:
            self.query_one(Static, classes="panel-title").update(
                f"[red]Nodes — Error: {error}[/red]"
            )

    @work(thread=True, exclusive=True, name="load-nodes")
    def _load_nodes(self) -> None:
        self._loading = True
        self._error = ""
        try:
            client = self.app.ctrl_client or self.app.oc_client
            if not client:
                self._error = "Not logged in."
                return
            from cb.services.node_service import list_nodes
            nodes = list_nodes(client)
            self.app.call_from_thread(self._populate_table, nodes)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, nodes: list) -> None:
        table = self.query_one(DataTable)
        table.clear()
        self.app._nodes = nodes
        for n in nodes:
            status = "[red]OFFLINE[/red]" if n.offline else "[green]ONLINE[/green]"
            labels = n.labels if isinstance(n.labels, str) else " ".join(n.labels)
            table.add_row(n.name[:30], status, str(n.num_executors), labels[:25])

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("nodes.", self.app._db_path)
        self._load_nodes()

    def action_toggle_offline(self) -> None:
        table = self.query_one(DataTable)
        nodes = getattr(self.app, "_nodes", [])
        if not nodes or table.cursor_row < 0 or table.cursor_row >= len(nodes):
            return
        node = nodes[table.cursor_row]
        action = "online" if node.offline else "offline"
        from cb.tui.widgets.modals import ConfirmModal
        def _on_confirm(confirmed: bool) -> None:
            if confirmed:
                self._do_toggle(node.name)
        self.app.push_screen(ConfirmModal(f"Mark node '{node.name}' {action}?"), _on_confirm)

    @work(thread=True, name="toggle-node")
    def _do_toggle(self, name: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.node_service import toggle_offline
            toggle_offline(client, name)
            self.app.call_from_thread(self.app.notify, f"Toggled: {name}", title="Node Updated")
            self._load_nodes()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Toggle Failed", severity="error"
            )
