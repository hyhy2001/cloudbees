"""Credentials pane -- list, create, delete.

Default: shows current user's credential store only (store='user').
Press S to toggle between user/system stores.
"""
from __future__ import annotations
from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import DataTable, Label, Static
from textual.reactive import reactive
from textual import work
from cb.tui.widgets.loader import AsciiLoader


class CredentialsPane(Widget):
    """Tab 2: User's credentials (default: user store). Toggle S for system."""

    DEFAULT_CSS = "CredentialsPane { height: 1fr; }"

    BINDINGS = [
        ("f5", "refresh",      "Refresh"),
        ("s",  "toggle_store", "Toggle Store"),
        ("c",  "create_cred",  "Create"),
        ("d",  "delete_cred",  "Delete"),
    ]

    _loading: reactive[bool] = reactive(True)
    _error:   reactive[str]  = reactive("")
    # Default: "user" store -- shows only current user's credentials
    _store:   reactive[str]  = reactive("user")

    def compose(self) -> ComposeResult:
        yield Label("", id="store-label")
        yield AsciiLoader(id="loader")
        yield DataTable(id="creds-table", cursor_type="row", zebra_stripes=True)

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("ID", "Type", "Description", "Scope")
        table.display = False
        self._update_store_label()
        self._load_creds()

    def on_focus(self) -> None:
        try:
            self.query_one(DataTable).focus()
        except Exception:
            pass

    def _update_store_label(self) -> None:
        store_display = (
            "[green]user (mine)[/green]"
            if self._store == "user"
            else "[yellow]system (shared)[/yellow]"
        )
        self.query_one("#store-label", Label).update(
            f"[bold]Credential store:[/bold] {store_display}  [dim](S to toggle)[/dim]"
        )

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display = not loading

    def watch__store(self, store: str) -> None:
        self._update_store_label()
        self._load_creds()

    def watch__error(self, error: str) -> None:
        if error:
            self.query_one("#store-label", Label).update(f"[red]Error: {error}[/red]")
        else:
            self._update_store_label()

    @work(thread=True, exclusive=True, name="load-creds")
    def _load_creds(self) -> None:
        self._loading = True
        self._error = ""
        try:
            client = self.app.ctrl_client or self.app.oc_client
            if not client:
                self._error = "Not logged in. Press L."
                return
            from cb.services.credential_service import list_credentials
            creds = list_credentials(
                client,
                username=getattr(self.app, "_username", ""),
                store=self._store,
            )
            self.app.call_from_thread(self._populate_table, creds)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, creds: list) -> None:
        table = self.query_one(DataTable)
        table.clear()
        self.app.bee_creds = creds
        for c in creds:
            table.add_row(
                c.id[:22], c.type_name[:22],
                (c.description or "")[:30], c.scope[:12],
            )

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        creds = self.app.bee_creds
        if not creds or event.cursor_row >= len(creds):
            return
        cred = creds[event.cursor_row]
        from cb.tui.screens.detail_screen import DetailScreen
        info = [
            ("ID",          cred.id),
            ("Type",        cred.type_name),
            ("Description", cred.description or ""),
            ("Scope",       cred.scope),
            ("Store",       self._store),
        ]
        actions = [
            ("d", "Delete", lambda c=cred: self._confirm_delete(c.id)),
        ]
        self.app.push_screen(
            DetailScreen(f"Credential: {cred.id}", info, actions)
        )

    def _confirm_delete(self, cred_id: str) -> None:
        from cb.tui.widgets.modals import ConfirmModal
        self.app.push_screen(
            ConfirmModal(f"Delete '{cred_id}' from {self._store} store?"),
            lambda confirmed: self._delete(cred_id) if confirmed else None,
        )

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("credentials.", self.app._db_path)
        self._load_creds()

    def action_toggle_store(self) -> None:
        self._store = "user" if self._store == "system" else "system"

    def action_delete_cred(self) -> None:
        table = self.query_one(DataTable)
        creds = self.app.bee_creds
        if not creds or table.cursor_row < 0 or table.cursor_row >= len(creds):
            return
        self._confirm_delete(creds[table.cursor_row].id)

    @work(thread=True, name="delete-cred")
    def _delete(self, cred_id: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.credential_service import delete_credential
            delete_credential(
                client, cred_id,
                username=getattr(self.app, "_username", ""),
                store=self._store,
            )
            self.app.call_from_thread(
                self.app.notify, f"Deleted: {cred_id}", title="Credential Deleted"
            )
            self._load_creds()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Delete Failed", severity="error"
            )

    def action_create_cred(self) -> None:
        from cb.tui.widgets.create_cred_modal import CreateCredModal
        store = self._store
        self.app.push_screen(
            CreateCredModal(),
            lambda result: self._create(**result, store=store) if result else None,
        )

    @work(thread=True, name="create-cred")
    def _create(self, cred_id: str, username: str, password: str, store: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.credential_service import create_username_password
            create_username_password(
                client, cred_id=cred_id, username_cred=username, password=password,
                username=getattr(self.app, "_username", ""), store=store,
            )
            self.app.call_from_thread(
                self.app.notify, f"Created: {cred_id}", title="Credential Created"
            )
            self._load_creds()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Create Failed", severity="error"
            )
