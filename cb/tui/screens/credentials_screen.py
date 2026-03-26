from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import DataTable, Footer, Label, Static
from textual.reactive import reactive
from textual import work
from cb.tui.widgets.loader import AsciiLoader


class CredentialsScreen(Screen):
    """Screen 2: List credentials; toggle between system/user store."""

    BINDINGS = [
        ("f5", "refresh", "Refresh"),
        ("s", "toggle_store", "Toggle Store"),
        ("c", "create_cred", "Create"),
        ("d", "delete_cred", "Delete"),
    ]

    _loading: reactive[bool] = reactive(True)
    _error: reactive[str] = reactive("")
    _store: reactive[str] = reactive("system")

    def compose(self) -> ComposeResult:
        yield Label("", id="store-label")
        yield AsciiLoader(id="loader")
        yield DataTable(id="creds-table", cursor_type="row")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("ID", "Type", "Description", "Scope")
        table.display = False
        self._load_creds()

    def watch__loading(self, loading: bool) -> None:
        self.query_one(AsciiLoader).display = loading
        self.query_one(DataTable).display = not loading

    def watch__store(self, store: str) -> None:
        self.query_one("#store-label", Label).update(
            f"[bold]Store:[/bold] [orange1]{store}[/orange1]  "
            f"[dim](S to toggle)[/dim]"
        )
        self._load_creds()

    def watch__error(self, error: str) -> None:
        if error:
            self.query_one("#store-label", Label).update(f"[red]Error: {error}[/red]")

    @work(thread=True, exclusive=True, name="load-creds")
    def _load_creds(self) -> None:
        self._loading = True
        self._error = ""
        try:
            client = self.app.ctrl_client or self.app.oc_client
            if not client:
                self._error = "Not logged in."
                return
            username = getattr(self.app, "_username", "")
            from cb.services.credential_service import list_credentials
            creds = list_credentials(client, username=username, store=self._store)
            self.app.call_from_thread(self._populate_table, creds)
        except Exception as exc:
            self._error = str(exc)
        finally:
            self._loading = False

    def _populate_table(self, creds: list) -> None:
        table = self.query_one(DataTable)
        table.clear()
        self.app._creds = creds
        for c in creds:
            table.add_row(c.id[:22], c.type_name[:22], (c.description or "")[:30], c.scope[:12])

    def action_refresh(self) -> None:
        from cb.cache.manager import invalidate_prefix
        invalidate_prefix("credentials.", self.app._db_path)
        self._load_creds()

    def action_toggle_store(self) -> None:
        self._store = "user" if self._store == "system" else "system"

    def action_delete_cred(self) -> None:
        table = self.query_one(DataTable)
        creds = getattr(self.app, "_creds", [])
        if not creds or table.cursor_row < 0 or table.cursor_row >= len(creds):
            return
        cred = creds[table.cursor_row]
        from cb.tui.widgets.modals import ConfirmModal
        def _on_confirm(confirmed: bool) -> None:
            if confirmed:
                self._delete(cred.id)
        self.app.push_screen(ConfirmModal(f"Delete credential '{cred.id}' from {self._store} store?"), _on_confirm)

    @work(thread=True, name="delete-cred")
    def _delete(self, cred_id: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.credential_service import delete_credential
            delete_credential(client, cred_id, username=getattr(self.app, "_username", ""), store=self._store)
            self.app.call_from_thread(self.app.notify, f"Deleted: {cred_id}", title="Credential Deleted")
            self._load_creds()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Delete Failed", severity="error"
            )

    def action_create_cred(self) -> None:
        from cb.tui.widgets.create_cred_modal import CreateCredModal
        def _on_result(result) -> None:
            if result:
                self._create(**result, store=self._store)
        self.app.push_screen(CreateCredModal(), _on_result)

    @work(thread=True, name="create-cred")
    def _create(self, cred_id: str, username: str, password: str, store: str) -> None:
        try:
            client = self.app.ctrl_client or self.app.oc_client
            from cb.services.credential_service import create_username_password
            create_username_password(
                client, cred_id=cred_id, username_cred=username, password=password,
                username=getattr(self.app, "_username", ""), store=store,
            )
            self.app.call_from_thread(self.app.notify, f"Created: {cred_id}", title="Credential Created")
            self._load_creds()
        except Exception as exc:
            self.app.call_from_thread(
                self.app.notify, str(exc), title="Create Failed", severity="error"
            )
