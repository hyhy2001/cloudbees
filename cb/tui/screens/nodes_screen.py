"""Nodes pane -- list agents, toggle offline/online.

Shows only nodes assigned to or labeled with the current user.
Press A to toggle between mine / all nodes.
"""
from __future__ import annotations
from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import DataTable, Static
from textual.reactive import reactive
from textual import work
from cb.tui.widgets.loader import AsciiLoader


class NodesPane(Widget):
    """Tab 3: Agent nodes list. Enter to see detail + toggle actions."""

    PANE_TITLE = "Nodes / Agents  (Enter=detail)"
    DEFAULT_CSS = "NodesPane { height: 1fr; }"

    BINDINGS = [
        ("f5", "refresh",        "Refresh"),
        ("a",  "toggle_all",     "Mine/All"),
        ("o",  "toggle_offline", "Toggle Offline"),
    ]

    _loading:   reactive[bool] = reactive(True)
    _error:     reactive[str]  = reactive("")
    _mine_only: reactive[bool] = reactive(True)

    def compose(self) -> ComposeResult:
        yield Static(self.PANE_TITLE, classes="panel-title")
        yield AsciiLoader(id="loader")
        yield DataTable(id="nodes-table", cursor_type="row", zebra_stripes=True)

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("Name", "Status", "Executors", "Labels")
        table.display = False
        self._load_nodes()

    def on_focus(self) -> None:
        try:
            self.query_one(DataTable).focus()
        except Exception:
            pass

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display = not loading

    def watch__mine_only(self, mine: bool) -> None:
        suffix = "  [green](mine)[/green]" if mine else "  [yellow](all)[/yellow]"
        self.query_one(".panel-title", Static).update(f"Nodes / Agents{suffix}")

    def watch__error(self, error: str) -> None:
        title = self.query_one(".panel-title", Static)
        if error:
            title.update(f"[red]Nodes -- {error}[/red]")
        else:
            self.watch__mine_only(self._mine_only)

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
            from cb.db.repositories.resource_repo import get_tracked_resources
            import cb.dtos.node as node_dto

            all_nodes = list_nodes(client)
            if self._mine_only:
                profile_name = getattr(self.app, "_username", "") or "default"
                tracked = get_tracked_resources("node", profile_name, controller_name=client.base_url, db_path=self.app._db_path)
                tracked_set = set(tracked)

                display_nodes = [n for n in all_nodes if n.name in tracked_set]
                server_names = {n.name for n in all_nodes}

                missing = tracked_set - server_names
                for m in list(missing):
                    display_nodes.append(node_dto.NodeDTO(name=m, offline=True, num_executors=0, labels="[DELETED_ON_SERVER]"))
                nodes = display_nodes
            else:
                nodes = all_nodes

            self.app.call_from_thread(self._populate_table, nodes)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, nodes: list) -> None:
        table = self.query_one(DataTable)
        table.clear()
        self.app.bee_nodes = nodes
        for n in nodes:
            status = "[red]OFFLINE[/red]" if n.offline else "[green]ONLINE[/green]"
            labels = n.labels if isinstance(n.labels, str) else " ".join(n.labels)
            table.add_row(n.name[:30], status, str(n.num_executors), labels[:25])

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        nodes = self.app.bee_nodes
        if not nodes or event.cursor_row >= len(nodes):
            return
        node = nodes[event.cursor_row]
        from cb.tui.screens.detail_screen import DetailScreen
        action_label = "Mark ONLINE (take back)" if node.offline else "Mark OFFLINE"
        info = [
            ("Name",      node.name),
            ("Status",    "OFFLINE" if node.offline else "ONLINE"),
            ("Executors", str(node.num_executors)),
            ("Labels",    node.labels if isinstance(node.labels, str) else " ".join(node.labels)),
        ]
        actions = [
            ("t", action_label, lambda n=node: self._confirm_toggle(n.name, n.offline)),
        ]
        self.app.push_screen(DetailScreen(f"Node: {node.name}", info, actions))

    def _confirm_toggle(self, name: str, is_offline: bool) -> None:
        action = "online" if is_offline else "offline"
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Mark node '{name}' {action}?"),
            lambda confirmed: self._do_toggle(name) if confirmed else None,
        )

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("nodes.", self.app._db_path)
        self._load_nodes()

    def action_toggle_all(self) -> None:
        self._mine_only = not self._mine_only
        self._load_nodes()

    def action_toggle_offline(self) -> None:
        table = self.query_one(DataTable)
        nodes = self.app.bee_nodes
        if not nodes or table.cursor_row < 0 or table.cursor_row >= len(nodes):
            return
        node = nodes[table.cursor_row]
        self._confirm_toggle(node.name, node.offline)

    @work(thread=True, name="toggle-node")
    def _do_toggle(self, name: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.node_service import toggle_offline
            toggle_offline(client, name)
            self.app.call_from_thread(
                self.app.notify, f"Toggled: {name}", title="Node Updated"
            )
            self._load_nodes()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Toggle Failed", severity="error"
            )
