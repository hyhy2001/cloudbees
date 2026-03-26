"""Modal for creating a new credential."""
from __future__ import annotations
from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Static
from textual.containers import Vertical


class CreateCredModal(ModalScreen):
    """Form to create a new Username+Password credential."""

    BINDINGS = [("escape", "dismiss(None)", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Label("Create Credential")
            yield Static("Credential ID", classes="dim")
            yield Input(placeholder="my-cred-id", id="cred-id")
            yield Static("Username", classes="dim")
            yield Input(placeholder="service-user", id="cred-username")
            yield Static("Password", classes="dim")
            yield Input(placeholder="••••••••", password=True, id="cred-password")
            yield Button("Create", variant="primary", id="btn-create")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-create":
            self._submit()

    def on_input_submitted(self, _) -> None:
        self._submit()

    def _submit(self) -> None:
        cred_id = self.query_one("#cred-id", Input).value.strip()
        username = self.query_one("#cred-username", Input).value.strip()
        password = self.query_one("#cred-password", Input).value
        if cred_id and username and password:
            self.dismiss({"cred_id": cred_id, "username": username, "password": password})
        else:
            self.query_one("#cred-id", Input).focus()
