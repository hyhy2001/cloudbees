"""Login modal screen."""
from __future__ import annotations
from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Static
from textual.containers import Vertical


class LoginModal(ModalScreen):
    """Modal form to collect credentials and log in."""

    BINDINGS = [("escape", "dismiss(None)", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Label("🐝  bee — Login to CloudBees")
            yield Static("Server URL", classes="dim")
            yield Input(placeholder="https://your-cloudbees.example.com", id="url")
            yield Static("Username", classes="dim")
            yield Input(placeholder="admin", id="login-username")
            yield Static("Password", classes="dim")
            yield Input(placeholder="••••••••", password=True, id="login-password")
            yield Button("Login", variant="primary", id="btn-login")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-login":
            self._submit()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self._submit()

    def _submit(self) -> None:
        url = self.query_one("#url", Input).value.strip()
        username = self.query_one("#login-username", Input).value.strip()
        password = self.query_one("#login-password", Input).value
        if url and username and password:
            self.dismiss({"url": url, "username": username, "password": password})
        else:
            self.query_one("#url", Input).focus()


class ConfirmModal(ModalScreen):
    """Generic yes/no confirmation modal."""

    BINDINGS = [("escape", "dismiss(False)", "Cancel")]

    def __init__(self, message: str, **kwargs):
        super().__init__(**kwargs)
        self._message = message

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Label("⚠  Confirm Action")
            yield Static(self._message)
            yield Button("Confirm", variant="error", id="btn-confirm")
            yield Button("Cancel", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-confirm":
            self.dismiss(True)
        else:
            self.dismiss(False)


class InfoModal(ModalScreen):
    """Display read-only key-value info panel."""

    BINDINGS = [("escape", "dismiss(None)", "Close"), ("enter", "dismiss(None)", "Close")]

    def __init__(self, title: str, rows: list[tuple[str, str]], **kwargs):
        super().__init__(**kwargs)
        self._title = title
        self._rows = rows

    def compose(self) -> ComposeResult:
        from textual.widgets import Static
        from textual.containers import Vertical
        with Vertical(id="modal-box"):
            yield Label(f"  {self._title}")
            for label, value in self._rows:
                if label:
                    yield Static(f"[dim]{label:<18}[/dim][bold]{value}[/bold]")
                else:
                    yield Static("")
            yield Static("[dim]Press Esc or Enter to close[/dim]")
