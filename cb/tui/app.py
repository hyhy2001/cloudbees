"""bee TUI — Textual-based interactive interface for CloudBees."""

from __future__ import annotations
import logging
from pathlib import Path
from typing import Optional

from textual.app import App, ComposeResult
from textual.reactive import reactive
from textual.widgets import Footer, Header, TabbedContent, TabPane
from textual import work
from cb.tui.compat import SYM

_log = logging.getLogger(__name__)
logging.basicConfig(
    filename="/tmp/bee.log",
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


class BeeApp(App):
    """🐝 bee — CloudBees TUI (Textual)."""

    CSS_PATH = "bee.tcss"

    TITLE = f"bee {SYM.bee} — CloudBees TUI"

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("l", "login", "Login"),
        ("x", "logout", "Logout"),
        ("f5", "refresh_active", "Refresh"),
        ("f2", "toggle_dark", "Dark/Light"),
        ("1", "switch_tab('controller')", "Controller"),
        ("2", "switch_tab('credentials')", "Credentials"),
        ("3", "switch_tab('nodes')", "Nodes"),
        ("4", "switch_tab('jobs')", "Jobs"),
        ("5", "switch_tab('settings')", "Settings"),
    ]

    # Reactive app-level state — updates cascade to screens automatically
    oc_client: reactive = reactive(None)     # Operations Center root client
    ctrl_client: reactive = reactive(None)   # Active controller-scoped client
    active_ctrl_name: reactive[str] = reactive("")

    # Shared data stores (populated by workers, read by screens)
    _controllers: list = []
    _jobs: list = []
    _creds: list = []
    _nodes: list = []
    _username: str = ""

    def __init__(self, db_path: Optional[Path] = None, **kwargs):
        super().__init__(**kwargs)
        self._db_path = db_path

    # ── Compose ────────────────────────────────────────

    def compose(self) -> ComposeResult:
        from cb.tui.screens.controller_screen import ControllerScreen
        from cb.tui.screens.credentials_screen import CredentialsScreen
        from cb.tui.screens.nodes_screen import NodesScreen
        from cb.tui.screens.jobs_screen import JobsScreen
        from cb.tui.screens.settings_screen import SettingsScreen

        yield Header()
        with TabbedContent(initial="controller"):
            with TabPane("1 Controller", id="controller"):
                yield ControllerScreen()
            with TabPane("2 Credentials", id="credentials"):
                yield CredentialsScreen()
            with TabPane("3 Nodes", id="nodes"):
                yield NodesScreen()
            with TabPane("4 Jobs", id="jobs"):
                yield JobsScreen()
            with TabPane("5 Settings", id="settings"):
                yield SettingsScreen()
        yield Footer()

    # ── Startup ────────────────────────────────────────

    def on_mount(self) -> None:
        self._restore_session()

    @work(thread=True, name="restore-session")
    def _restore_session(self) -> None:
        """Auto-login from saved session without blocking UI."""
        try:
            from cb.db.connection import init_db
            from cb.services.session import load_session
            from cb.api.client import CloudBeesClient

            init_db(self._db_path)
            session = load_session(self._db_path)
            if not session or not session.get("server_url"):
                self.app.call_from_thread(
                    self.notify, "Not logged in. Press L to login.", title="bee")
                return

            self._username = session.get("username", "")
            oc = CloudBeesClient(session["server_url"], session["raw_token"], db_path=self._db_path)
            self.app.call_from_thread(setattr, self, "oc_client", oc)
            self.app.call_from_thread(setattr, self, "ctrl_client", oc)

            # Restore active controller
            from cb.services.controller_service import get_active_controller
            ctrl = get_active_controller(self._db_path, oc)
            if ctrl and ctrl[1]:
                self.app.call_from_thread(setattr, self, "active_ctrl_name", ctrl[0])
                new_client = CloudBeesClient(
                    base_url=ctrl[1].rstrip("/"),
                    token=oc._token,
                    db_path=self._db_path,
                )
                self.app.call_from_thread(setattr, self, "ctrl_client", new_client)

            self.app.call_from_thread(
                self.notify,
                f"Logged in as {self._username}" + (f" · {ctrl[0]}" if ctrl else ""),
                title="bee",
            )
        except Exception as exc:
            _log.exception("Session restore failed")
            self.app.call_from_thread(
                self.notify, f"Session error: {exc}", title="bee", severity="warning"
            )

    # ── Dynamic header subtitle ────────────────────────

    def watch_active_ctrl_name(self, name: str) -> None:
        ctrl_suffix = f" · {name}" if name else ""
        self.sub_title = f"{self._username}{ctrl_suffix}" if self._username else "not connected"

    def watch_oc_client(self, client) -> None:
        if client and not self._username:
            self.sub_title = "connected"

    # ── Global key actions ─────────────────────────────

    def action_switch_tab(self, tab_id: str) -> None:
        tabs = self.query_one(TabbedContent)
        tabs.active = tab_id

    def action_refresh_active(self) -> None:
        """Delegate F5 to the active tab's screen."""
        try:
            active = self.query_one(TabbedContent).active
            self.post_message_to_all_widgets = False  # suppress
            # Focus the active tab pane and trigger its refresh action
            self.action_switch_tab(active)
        except Exception:
            pass

    def action_login(self) -> None:
        from cb.tui.widgets.modals import LoginModal
        def _on_login(result) -> None:
            if result:
                self._do_login(result["url"], result["username"], result["password"])
        self.push_screen(LoginModal(), _on_login)

    @work(thread=True, name="login")
    def _do_login(self, url: str, username: str, password: str) -> None:
        try:
            from cb.services.auth_service import login
            from cb.services.session import load_session
            from cb.api.client import CloudBeesClient

            profile = login(
                server_url=url,
                username=username,
                password=password,
                profile_name="default",
                db_path=self._db_path,
            )
            session = load_session(self._db_path)
            if session:
                self._username = username
                oc = CloudBeesClient(session["server_url"], session["raw_token"], db_path=self._db_path)
                self.app.call_from_thread(setattr, self, "oc_client", oc)
                self.app.call_from_thread(setattr, self, "ctrl_client", oc)
                self.app.call_from_thread(setattr, self, "active_ctrl_name", "")
                self.app.call_from_thread(
                    self.notify, f"Logged in as {username}", title="Login OK"
                )
        except Exception as exc:
            self.app.call_from_thread(
                self.notify, str(exc), title="Login Failed", severity="error"
            )

    def action_logout(self) -> None:
        from cb.services.session import clear_session
        clear_session(self._db_path)
        self.oc_client = None
        self.ctrl_client = None
        self.active_ctrl_name = ""
        self._username = ""
        self.sub_title = "not connected"
        self.notify("Session cleared.", title="Logged Out")

def _ensure_utf8() -> None:
    """Force UTF-8 I/O so Textual/Rich renders correctly on LANG=C systems.

    On many corporate Linux servers LANG=C (POSIX/ASCII locale). Python opens
    stdout with ASCII encoding, so every Unicode box-drawing character that
    Rich/Textual tries to write becomes ??? or raises UnicodeEncodeError.

    Fix: set LANG=C.UTF-8 (keeps POSIX collation, adds full Unicode I/O) and
    reconfigure sys.stdout/stderr to UTF-8 BEFORE Textual initialises its
    Console object.
    """
    import os, sys

    active = (os.environ.get("LC_ALL") or os.environ.get("LANG") or "C").upper()
    if "UTF" in active:
        return  # already UTF-8, nothing to do

    os.environ["LANG"] = "C.UTF-8"  # UTF-8 I/O, POSIX sort order
    os.environ["PYTHONIOENCODING"] = "utf-8:replace"  # never crash on bad chars

    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            continue
        try:
            if hasattr(stream, "reconfigure"):          # Python 3.7+, preferred
                stream.reconfigure(encoding="utf-8", errors="replace")
            elif hasattr(stream, "buffer"):             # fallback: re-wrap
                import io
                setattr(sys, name,
                        io.TextIOWrapper(stream.buffer,
                                         encoding="utf-8",
                                         errors="replace",
                                         line_buffering=stream.line_buffering))
        except Exception:
            pass  # non-wrappable stream (piped/redirected) — skip silently


def main(db_path: Optional[Path] = None) -> None:
    """Entry point called from cb/main.py."""
    _ensure_utf8()
    app = BeeApp(db_path=db_path)
    app.run()
