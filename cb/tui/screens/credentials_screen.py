"""Credentials pane — list, create, delete. System and user stores."""
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


class CredentialsPane(VimNavMixin, Widget):
    """Tab 2: Credentials — dual store (user/system), create, delete."""

    DEFAULT_CSS = "CredentialsPane { height: 1fr; }"

    BINDINGS = [
        ("f5",    "refresh",      "Refresh"),
        ("a",     "toggle_all",   "Mine/All"),
        ("S",     "toggle_store", "Sys/User"),
        ("c",     "create_cred",  "Create"),
        ("d",     "delete_cred",  "Delete"),
        ("enter", "open_detail",  "Detail"),
    ]

    _loading:  reactive[bool] = reactive(True)
    _error:    reactive[str]  = reactive("")
    _show_all: reactive[bool] = reactive(True)
    _store:    reactive[str]  = reactive("user")

    def compose(self) -> ComposeResult:
        yield Static("", classes="pane-header", id="creds-header")
        yield Static("", classes="filter-bar",  id="creds-filter")
        with Horizontal(id="creds-action-bar", classes="action-bar"):
            yield Button(f"{SYM.gear} Create  [dim][c][/dim]",    id="cbtn-create", classes="abtn abtn-success")
            yield Button(f"{SYM.warn} Delete  [dim][d][/dim]",    id="cbtn-delete", classes="abtn abtn-danger")
            yield Button(f"{SYM.pipe} Store   [dim][S][/dim]",    id="cbtn-store",  classes="abtn abtn-info")
            yield Button(f"{SYM.dot}  All/Mine[dim][a][/dim]",    id="cbtn-scope",  classes="abtn abtn-muted")
        yield AsciiLoader(id="loader")
        yield DataTable(id="creds-table", cursor_type="row", zebra_stripes=True)
        with Vertical(id="detail-panel"):
            yield Static(
                f"[dim]{SYM.arrow} Navigate to a credential to see details[/dim]",
                id="detail-panel-content",
            )

    def on_mount(self) -> None:
        t = self.query_one(DataTable)
        t.add_columns("ID", "Type", "Description", "Scope")
        t.display = False
        self._update_header()
        self._load_creds()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        dispatch = {
            "cbtn-create": self.action_create_cred,
            "cbtn-delete": self.action_delete_cred,
            "cbtn-store":  self.action_toggle_store,
            "cbtn-scope":  self.action_toggle_all,
        }
        fn = dispatch.get(event.button.id)
        if fn:
            try:
                self.query_one(DataTable).focus()
            except Exception:
                pass
            fn()

    def on_focus(self) -> None:
        try:
            self.query_one(DataTable).focus()
        except Exception:
            pass

    # ── Header helpers ─────────────────────────────────────────

    def _update_header(self) -> None:
        self.query_one("#creds-header", Static).update(
            f" {SYM.gear} Credentials  "
            f"[dim]c=create · d=delete · s=store · a=mine/all · F5=refresh[/dim]"
        )
        store_color = "green" if self._store == "user" else "yellow"
        store_label = (
            f"[{store_color}]{self._store.upper()}[/{store_color}]"
        )
        scope = "[yellow]ALL[/yellow]" if self._show_all else "[green]MINE[/green]"
        self.query_one("#creds-filter", Static).update(
            f" {SYM.arrow} Store: {store_label}   Scope: {scope}  "
            f"[dim](s=toggle store · a=toggle scope)[/dim]"
        )

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display   = not loading

    def watch__error(self, error: str) -> None:
        if error:
            self.query_one("#creds-header", Static).update(
                f"[red]{SYM.fail} Credentials — {error}[/red]"
            )
        else:
            self._update_header()

    def watch__store(self, _: str) -> None:
        self._update_header()
        self._load_creds()

    def watch__show_all(self, _: bool) -> None:
        self._update_header()
        self._load_creds()

    # ── Cursor hover → inline detail ──────────────────────────

    def on_data_table_cursor_moved(self, event: DataTable.CursorMoved) -> None:
        creds = self.app.bee_creds
        if not creds or event.cursor_row >= len(creds):
            return
        c = creds[event.cursor_row]
        self.query_one("#detail-panel-content", Static).update(
            f"[bold]{c.id}[/bold]   [dim]type:[/dim] {c.type_name}   "
            f"[dim]scope:[/dim] {c.scope}   [dim]store:[/dim] {self._store}\n"
            f"[dim]desc:[/dim] {c.description or '—'}"
        )

    # ── Data loading ───────────────────────────────────────────

    @work(thread=True, exclusive=True, name="load-creds")
    def _load_creds(self) -> None:
        self._loading = True
        self._error   = ""
        try:
            client = self.app.ctrl_client or self.app.oc_client
            if not client:
                self._error = "Not logged in — press L"
                return
            from cb.services.credential_service import list_credentials
            from cb.db.repositories.resource_repo import get_tracked_resources
            import cb.dtos.credential as cred_dto

            username_str = getattr(self.app, "_username", "")
            all_creds = list_credentials(client, username=username_str, store=self._store)

            if not self._show_all:
                profile = username_str or "default"
                tracked  = get_tracked_resources(
                    "credential", profile,
                    controller_name=client.base_url,
                    db_path=self.app._db_path,
                )
                tracked_set   = set(tracked)
                display_creds = [c for c in all_creds if c.id in tracked_set]
                server_ids    = {c.id for c in all_creds}
                for m in tracked_set - server_ids:
                    display_creds.append(
                        cred_dto.CredentialDTO(id=m, type_name="[DELETED]",
                                               description="[DELETED_ON_SERVER]")
                    )
                creds = display_creds
            else:
                creds = all_creds

            self.app.call_from_thread(self._populate_table, creds)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, creds: list) -> None:
        t = self.query_one(DataTable)
        t.clear()
        self.app.bee_creds = creds
        for c in creds:
            t.add_row(
                c.id[:24],
                c.type_name[:18],
                (c.description or "")[:32],
                c.scope[:12],
            )

    # ── Row select → detail screen ─────────────────────────────

    def action_open_detail(self) -> None:
        """Open detail screen — triggered ONLY by Enter key."""
        t = self.query_one(DataTable)
        creds = self.app.bee_creds
        if not creds or not (0 <= t.cursor_row < len(creds)):
            return
        cred = creds[t.cursor_row]
        from cb.tui.screens.detail_screen import DetailScreen
        info = [
            ("ID",          cred.id),
            ("Type",        cred.type_name),
            ("Description", cred.description or ""),
            ("Scope",       cred.scope),
            ("Store",       self._store),
        ]
        actions = [
            ("d", f"{SYM.warn} Delete", lambda c=cred: self._confirm_delete(c.id)),
        ]
        self.app.push_screen(
            DetailScreen(f"Credential: {cred.id}", info, actions)
        )

    # ── Bindings ───────────────────────────────────────────────

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("credentials.", self.app._db_path)
        self._load_creds()

    def action_toggle_all(self) -> None:
        self._show_all = not self._show_all

    def action_toggle_store(self) -> None:
        self._store = "user" if self._store == "system" else "system"

    def action_delete_cred(self) -> None:
        creds = self.app.bee_creds
        row   = self.query_one(DataTable).cursor_row
        if creds and 0 <= row < len(creds):
            self._confirm_delete(creds[row].id)

    def action_create_cred(self) -> None:
        from cb.tui.widgets.create_cred_modal import CreateCredModal
        store = self._store
        self.app.push_screen(
            CreateCredModal(),
            lambda result: self._do_create(**result, store=store) if result else None,
        )

    # ── Workers ────────────────────────────────────────────────

    def _confirm_delete(self, cred_id: str) -> None:
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Delete '{cred_id}' from {self._store} store?"),
            lambda ok: self._do_delete(cred_id) if ok else None,
        )

    @work(thread=True, name="delete-cred")
    def _do_delete(self, cred_id: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.credential_service import delete_credential
            delete_credential(
                client, cred_id,
                username=getattr(self.app, "_username", ""),
                store=self._store,
            )
            from cb.db.repositories.resource_repo import untrack_resource
            profile = getattr(self.app, "_username", "") or "default"
            untrack_resource("credential", cred_id, profile,
                             controller_name=client.base_url,
                             db_path=self.app._db_path)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Deleted: [bold]{cred_id}[/bold]",
                title="Credential Deleted",
            )
            self._load_creds()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Delete Failed", severity="error"
            )

    @work(thread=True, name="create-cred")
    def _do_create(self, cred_id: str, username: str, password: str,
                   store: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.credential_service import create_username_password
            create_username_password(
                client, cred_id=cred_id, username_cred=username, password=password,
                username=getattr(self.app, "_username", ""), store=store,
            )
            from cb.db.repositories.resource_repo import track_resource
            profile = getattr(self.app, "_username", "") or "default"
            track_resource("credential", cred_id, profile,
                           controller_name=client.base_url,
                           db_path=self.app._db_path)
            self.app.call_from_thread(
                self.app.notify,
                f"{SYM.ok} Created: [bold]{cred_id}[/bold]",
                title="Credential Created",
            )
            self._load_creds()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Create Failed", severity="error"
            )
