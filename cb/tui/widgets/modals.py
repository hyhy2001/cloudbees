"""All TUI modal screens: Login, Confirm, Info, CreateJob, CreateNode."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static, TextArea

from cb.tui.compat import SYM


# ── Login Modal ───────────────────────────────────────────────


class LoginModal(ModalScreen):
    """Modal form: server URL + username + password."""

    BINDINGS = [("escape", "dismiss(None)", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Static(
                f" {SYM.bee} Login to CloudBees CI",
                classes="modal-title",
            )
            yield Static("Server URL", classes="modal-section")
            yield Input(
                placeholder="https://your-cloudbees.example.com",
                id="url",
            )
            yield Static("Username", classes="modal-section")
            yield Input(placeholder="admin", id="login-username")
            yield Static("Password", classes="modal-section")
            yield Input(placeholder="●●●●●●●●", password=True, id="login-password")
            with Horizontal(classes="btn-row"):
                yield Button("Login", variant="primary", id="btn-login")
                yield Button("Cancel", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-login":
            self._submit()
        else:
            self.dismiss(None)

    def on_input_submitted(self, _) -> None:
        self._submit()

    def _submit(self) -> None:
        url      = self.query_one("#url",            Input).value.strip()
        username = self.query_one("#login-username", Input).value.strip()
        password = self.query_one("#login-password", Input).value
        if url and username and password:
            self.dismiss({"url": url, "username": username, "password": password})
        else:
            self.query_one("#url", Input).focus()


# ── Confirm Modal ─────────────────────────────────────────────


class ConfirmModal(ModalScreen):
    """Generic yes / no confirmation."""

    BINDINGS = [
        ("escape", "dismiss(False)", "Cancel"),
        ("y",      "confirm",        "Yes"),
        ("n",      "dismiss(False)", "No"),
    ]

    def __init__(self, message: str, **kwargs):
        super().__init__(**kwargs)
        self._message = message

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Static(
                f" {SYM.warn_tri} Confirm Action",
                classes="modal-title",
            )
            yield Static(self._message)
            with Horizontal(classes="btn-row"):
                yield Button("Confirm", variant="error",   id="btn-confirm")
                yield Button("Cancel",  variant="default", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "btn-confirm")

    def action_confirm(self) -> None:
        self.dismiss(True)


# ── Info Modal ────────────────────────────────────────────────


class InfoModal(ModalScreen):
    """Read-only key-value info panel."""

    BINDINGS = [
        ("escape", "dismiss(None)", "Close"),
        ("enter",  "dismiss(None)", "Close"),
        ("q",      "dismiss(None)", "Close"),
    ]

    def __init__(self, title: str, rows: list[tuple[str, str]], **kwargs):
        super().__init__(**kwargs)
        self._title = title
        self._rows  = rows

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Static(f" {SYM.arrow} {self._title}", classes="modal-title")
            for label, value in self._rows:
                if label:
                    yield Static(
                        f"[dim]{label:<16}[/dim] [bold]{value}[/bold]"
                    )
                else:
                    yield Static("")
            yield Static(f"\n[dim]Press Esc / Enter / q to close[/dim]")


# ── Create Job Modal ──────────────────────────────────────────


_JOB_TYPES = [
    ("Freestyle Project", "freestyle"),
    ("Pipeline",          "pipeline"),
    ("Folder",            "folder"),
]


class CreateJobModal(ModalScreen):
    """Form to create a new job (freestyle / pipeline / folder)."""

    BINDINGS = [("escape", "dismiss(None)", "Cancel")]

    _job_type: str = "freestyle"

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Static(
                f" {SYM.gear} Create New Job",
                classes="modal-title",
            )
            yield Static("Job Name *", classes="modal-section")
            yield Input(placeholder="my-job-name", id="job-name")

            yield Static("Type *", classes="modal-section")
            yield Select(
                options=[(label, val) for label, val in _JOB_TYPES],
                value="freestyle",
                id="job-type",
            )

            yield Static("Description", classes="modal-section")
            yield Input(placeholder="Optional description", id="job-desc")

            yield Static(
                "Shell Command  [dim](Freestyle only)[/dim]",
                classes="modal-section",
            )
            yield Input(placeholder="echo hello", id="job-shell")

            yield Static(
                "Pipeline Script  [dim](Pipeline only — leave blank for default)[/dim]",
                classes="modal-section",
            )
            yield TextArea(
                text="pipeline {\n  agent any\n  stages {\n    stage('Build') {\n      steps { echo 'Hello from bee!' }\n    }\n  }\n}",
                id="job-script",
                language="groovy",
            )

            with Horizontal(classes="btn-row"):
                yield Button("Create", variant="primary", id="btn-create")
                yield Button("Cancel",                    id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-create":
            self._submit()
        else:
            self.dismiss(None)

    def _submit(self) -> None:
        name = self.query_one("#job-name",  Input).value.strip()
        if not name:
            self.query_one("#job-name", Input).focus()
            return
        try:
            sel = self.query_one("#job-type", Select)
            job_type = str(sel.value) if sel.value else "freestyle"
        except Exception:
            job_type = "freestyle"

        desc      = self.query_one("#job-desc",   Input).value.strip()
        shell_cmd = self.query_one("#job-shell",  Input).value.strip()
        try:
            script = self.query_one("#job-script", TextArea).text.strip()
        except Exception:
            script = ""
        self.dismiss({
            "name":      name,
            "job_type":  job_type,
            "desc":      desc,
            "shell_cmd": shell_cmd,
            "script":    script,
        })


# ── Create Node Modal ─────────────────────────────────────────


class CreateNodeModal(ModalScreen):
    """Form to create a new permanent agent node."""

    BINDINGS = [("escape", "dismiss(None)", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Static(
                f" {SYM.gear} Create New Node / Agent",
                classes="modal-title",
            )
            yield Static("Node Name *", classes="modal-section")
            yield Input(placeholder="my-agent", id="node-name")
            yield Static("Remote Working Directory *", classes="modal-section")
            yield Input(placeholder="/home/jenkins", id="node-remote-dir")
            yield Static("Num Executors", classes="modal-section")
            yield Input(placeholder="1", id="node-executors")
            yield Static("Labels  [dim](space-separated)[/dim]", classes="modal-section")
            yield Input(placeholder="linux docker", id="node-labels")
            with Horizontal(classes="btn-row"):
                yield Button("Create", variant="primary", id="btn-create")
                yield Button("Cancel",                    id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-create":
            self._submit()
        else:
            self.dismiss(None)

    def on_input_submitted(self, _) -> None:
        self._submit()

    def _submit(self) -> None:
        name       = self.query_one("#node-name",       Input).value.strip()
        remote_dir = self.query_one("#node-remote-dir", Input).value.strip()
        if not name or not remote_dir:
            self.query_one("#node-name", Input).focus()
            return
        try:
            num_exec = int(self.query_one("#node-executors", Input).value.strip() or "1")
        except ValueError:
            num_exec = 1
        labels = self.query_one("#node-labels", Input).value.strip()
        self.dismiss({
            "name":          name,
            "remote_dir":    remote_dir,
            "num_executors": num_exec,
            "labels":        labels,
        })
