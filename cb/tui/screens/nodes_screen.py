"""Nodes pane — list agents, toggle offline/online, create, delete."""
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


def _node_status(offline: bool) -> str:
    if offline:
        return f"[red]{SYM.offline} OFFLINE[/red]"
    return f"[green]{SYM.online} ONLINE[/green]"


class NodesPane(VimNavMixin, Widget):
    """Tab 3: Agent nodes — list, toggle, create, delete."""

    DEFAULT_CSS = "NodesPane { height: 1fr; }"

    BINDINGS = [
        ("f5",    "refresh",        "Refresh"),
        ("a",     "toggle_all",     "Mine/All"),
        ("o",     "toggle_offline", "Toggle"),
        ("n",     "create_node",    "New Node"),
        ("d",     "delete_node",    "Delete"),
        ("enter", "open_detail",    "Detail"),
    ]

    _loading:   reactive[bool] = reactive(True)
    _error:     reactive[str]  = reactive("")
    _mine_only: reactive[bool] = reactive(True)

    def compose(self) -> ComposeResult:
        yield Static("", classes="pane-header", id="nodes-header")
        yield Static("", classes="filter-bar",  id="nodes-filter")
        yield AsciiLoader(id="loader")
        yield DataTable(id="nodes-table", cursor_type="row", zebra_stripes=True)
        with Vertical(id="detail-panel"):
            yield Static(
                f"[dim]{SYM.arrow} Navigate to a node to see details[/dim]",
                id="detail-panel-content",
            )

    def on_mount(self) -> None:
        t = self.query_one(DataTable)
        t.add_columns("Status", "Name", "Executors", "Labels", "Description")
        t.display = False
        self._update_header()
        self._load_nodes()

    def on_focus(self) -> None:
        try:
            self.query_one(DataTable).focus()
        except Exception:
            pass

    # ── Header helpers ─────────────────────────────────────────

    def _update_header(self) -> None:
        self.query_one("#nodes-header", Static).update(
            f" {SYM.gear} Nodes / Agents  "
            f"[dim]o=toggle · n=new · d=del · a=mine/all · F5=refresh[/dim]"
        )
        scope = "[green]MINE[/green]" if self._mine_only else "[yellow]ALL[/yellow]"
        self.query_one("#nodes-filter", Static).update(
            f" {SYM.arrow} Scope: {scope}"
        )

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display   = not loading

    def watch__error(self, error: str) -> None:
        if error:
            self.query_one("#nodes-header", Static).update(
                f"[red]{SYM.fail} Nodes — {error}[/red]"
            )
        else:
            self._update_header()

    def watch__mine_only(self, _: bool) -> None:
        self._update_header()

    # ── Cursor hover → inline detail ──────────────────────────

    def on_data_table_cursor_moved(self, event: DataTable.CursorMoved) -> None:
        nodes = self.app.bee_nodes
        if not nodes or event.cursor_row >= len(nodes):
            return
        n = nodes[event.cursor_row]
        labels = n.labels if isinstance(n.labels, str) else " ".join(n.labels)
        self.query_one("#detail-panel-content", Static).update(
            f"[bold]{n.name}[/bold]   {_node_status(n.offline)}   "
            f"[dim]executors:[/dim] {n.num_executors}\n"
            f"[dim]labels:[/dim] {labels or '—'}   "
            f"[dim]desc:[/dim] {(n.description or '—')[:50]}"
        )

    # ── Data loading ───────────────────────────────────────────

    @work(thread=True, exclusive=True, name="load-nodes")
    def _load_nodes(self) -> None:
        self._loading = True
        self._error   = ""
        self._load_worker()

    @work(thread=True, exclusive=True)
    def _load_worker(self) -> None:
        client = getattr(self.app, "ctrl_client", None)
        if not client:
            self._loading = False
            self._error = "Not logged in — press L"
            return
        try:
            from cb.services.node_service import list_nodes
            from cb.db.repositories.resource_repo import get_tracked_resources
            import cb.dtos.node as node_dto

            all_nodes = list_nodes(client)

            if self._mine_only:
                profile = "default"
                tracked = get_tracked_resources(
                    "node", profile,
                    controller_name=client.base_url,
                    db_path=self.app._db_path,
                )
                tracked_set  = set(tracked)
                display_nodes = [n for n in all_nodes if n.name in tracked_set]
                server_names  = {n.name for n in all_nodes}
                for m in tracked_set - server_names:
                    display_nodes.append(
                        node_dto.NodeDTO(
                            name=m, offline=True, num_executors=0,
                            labels="[DELETED_ON_SERVER]"
                        )
                    )
                nodes = display_nodes
            else:
                nodes = all_nodes

            self.app.call_from_thread(self._populate_table, nodes)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, nodes: list) -> None:
        t = self.query_one(DataTable)
        t.clear()
        self.app.bee_nodes = nodes
        for n in nodes:
            labels = n.labels if isinstance(n.labels, str) else " ".join(n.labels)
            t.add_row(
                _node_status(n.offline),
                n.name[:30],
                str(n.num_executors),
                labels[:24],
                (n.description or "")[:28],
            )

    # ── Row select → detail screen ─────────────────────────────

    def action_open_detail(self) -> None:
        """Open detail screen — triggered ONLY by Enter key."""
        t = self.query_one(DataTable)
        nodes = self.app.bee_nodes
        if not nodes or not (0 <= t.cursor_row < len(nodes)):
            return
        node = nodes[t.cursor_row]
        self._open_detail_worker(node)

    @work(thread=True, exclusive=True, name="open-detail")
    def _open_detail_worker(self, node) -> None:
        try:
            client = getattr(self.app, "ctrl_client", None)
            if getattr(self.app, "_username", "") and client:
                from cb.services.node_service import get_node
                detailed_node = get_node(client, node.name)
                if detailed_node:
                    node = detailed_node
                    
            from cb.tui.screens.detail_screen import DetailScreen
            labels = node.labels if isinstance(node.labels, str) else " ".join(node.labels)
            action_label = f"{SYM.online} Mark ONLINE" if node.offline else f"{SYM.offline} Mark OFFLINE"
            info = [
                ("Name",      node.name),
                ("Status",    "OFFLINE" if node.offline else "ONLINE"),
                ("Executors", str(node.num_executors)),
                ("Labels",    labels or "-"),
                ("Desc",      node.description or "-"),
            ]
            actions = [
                ("o", action_label, lambda n=node: self._confirm_toggle(n.name, n.offline)),
                ("d", f"{SYM.warn} Delete Node", lambda n=node: self._confirm_delete(n.name)),
            ]
            self.app.call_from_thread(self.app.push_screen, DetailScreen(f"Node: {node.name}", info, actions))
        except Exception as e:
            self.app.call_from_thread(self.app.notify, f"Error: {e}", severity="error")

    # ── Bindings ───────────────────────────────────────────────

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("nodes.", self.app._db_path)
        self._load_nodes()

    def action_toggle_all(self) -> None:
        self._mine_only = not self._mine_only
        self._load_nodes()

    def action_toggle_offline(self) -> None:
        nodes = self.app.bee_nodes
        row   = self.query_one(DataTable).cursor_row
        if nodes and 0 <= row < len(nodes):
            n = nodes[row]
            self._confirm_toggle(n.name, n.offline)

    def action_create_node(self) -> None:
        from cb.tui.widgets.modals import CreateNodeModal
        self.app.push_screen(
            CreateNodeModal(),
            lambda result: self._do_create(**result) if result else None,
        )

    def action_delete_node(self) -> None:
        nodes = self.app.bee_nodes
        row   = self.query_one(DataTable).cursor_row
        if nodes and 0 <= row < len(nodes):
            self._confirm_delete(nodes[row].name)

    # ── Workers ────────────────────────────────────────────────

    def _confirm_toggle(self, name: str, is_offline: bool) -> None:
        action = "ONLINE" if is_offline else "OFFLINE"
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Mark node '{name}' {action}?"),
            lambda ok: self._do_toggle(name, is_offline) if ok else None,
        )

    def _confirm_delete(self, name: str) -> None:
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Delete node '{name}'? This cannot be undone."),
            lambda ok: self._do_delete(name) if ok else None,
        )

    @work(thread=True, name="toggle-node")
    def _do_toggle(self, node_name: str, to_offline: bool) -> None:
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client: return
            from cb.services.node_service import toggle_offline
            toggle_offline(client, node_name)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Toggled: [bold]{node_name}[/bold]",
                title="Node Updated",
            )
            self._load_nodes()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Toggle Failed", severity="error"
            )

    @work(thread=True, name="delete-node")
    def _do_delete(self, node_name: str) -> None:
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client: return
            from cb.services.node_service import delete_node
            delete_node(client, node_name)
            from cb.db.repositories.resource_repo import untrack_resource
            profile = "default"
            untrack_resource("node", node_name, profile,
                             controller_name=client.base_url,
                             db_path=self.app._db_path)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Deleted: [bold]{name}[/bold]",
                title="Node Deleted",
            )
            self._load_nodes()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Delete Failed", severity="error"
            )

    @work(thread=True, name="create-node")
    def _do_create(self, name: str, remote_dir: str,
                   num_executors: int = 1, labels: str = "") -> None:
        try:
            client = getattr(self.app, "ctrl_client", None)
            if not client: return
            from cb.services.node_service import create_permanent_node
            create_permanent_node(
                client, name=name, remote_dir=remote_dir,
                num_executors=num_executors, labels=labels,
            )
            from cb.db.repositories.resource_repo import track_resource
            profile = "default"
            track_resource("node", name, profile,
                           controller_name=client.base_url,
                           db_path=self.app._db_path)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Created node: [bold]{name}[/bold]",
                title="Node Created",
            )
            self._load_nodes()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Create Failed", severity="error"
            )
