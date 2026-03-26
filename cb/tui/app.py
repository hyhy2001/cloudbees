"""bee TUI -- Textual-based interactive interface for CloudBees."""

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
    """bee CloudBees TUI (Textual)."""

    CSS_PATH = "bee.tcss"

    TITLE = "bee -- CloudBees TUI"
    ENABLE_COMMAND_PALETTE = False  # disables ctrl+p (unicode icon in footer)

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

    # Reactive app-level state -- Textual manages these as descriptors
    oc_client:         reactive = reactive(None)   # Operations Center root client
    ctrl_client:       reactive = reactive(None)   # Active controller-scoped client
    active_ctrl_name:  reactive[str] = reactive("")  # Currently selected controller name

    def __init__(self, db_path: Optional[Path] = None, **kwargs):
        super().__init__(**kwargs)
        self._db_path = db_path
        # Data caches for tab panes -- prefixed with 'bee_' to avoid
        # shadowing Textual's own internal attrs (_nodes = NodeList, etc.)
        self.bee_controllers = []
        self.bee_jobs        = []
        self.bee_creds       = []
        self.bee_nodes       = []
        self._username       = ""

    # -- Compose ----------------------------------------

    def compose(self) -> ComposeResult:
        from cb.tui.screens.controller_screen import ControllerPane
        from cb.tui.screens.credentials_screen import CredentialsPane
        from cb.tui.screens.nodes_screen import NodesPane
        from cb.tui.screens.jobs_screen import JobsPane
        from cb.tui.screens.settings_screen import SettingsPane

        yield Header()
        with TabbedContent(initial="controller"):
            with TabPane("1 Controller", id="controller"):
                yield ControllerPane()
            with TabPane("2 Credentials", id="credentials"):
                yield CredentialsPane()
            with TabPane("3 Nodes", id="nodes"):
                yield NodesPane()
            with TabPane("4 Jobs", id="jobs"):
                yield JobsPane()
            with TabPane("5 Settings", id="settings"):
                yield SettingsPane()
        yield Footer()

    # -- Startup ----------------------------------------

    def on_mount(self) -> None:
        # Set Header icon to ASCII '>' -- default is U+2B58 (heavy circle -> ???)
        try:
            self.query_one(Header).icon = ">"
        except Exception:
            pass
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
                f"Logged in as {self._username}" + (f" [{ctrl[0]}]" if ctrl else ""),
                title="bee",
            )
            # Trigger all panes to reload now we have a live client
            self.app.call_from_thread(self._refresh_all_panes)
        except Exception as exc:
            _log.exception("Session restore failed")
            self.app.call_from_thread(
                self.notify, f"Session error: {exc}", title="bee", severity="warning"
            )

    # -- Dynamic header subtitle ------------------------

    def watch_active_ctrl_name(self, name: str) -> None:
        ctrl_suffix = f" [{name}]" if name else ""
        self.sub_title = f"{self._username}{ctrl_suffix}" if self._username else "not connected"

    def watch_oc_client(self, client) -> None:
        if client and not self._username:
            self.sub_title = "connected"

    # -- Global key actions -----------------------------

    def action_switch_tab(self, tab_id: str) -> None:
        tabs = self.query_one(TabbedContent)
        tabs.active = tab_id

    def on_tabbed_content_tab_activated(
        self, event: TabbedContent.TabActivated
    ) -> None:
        """Auto-focus the DataTable in the newly-active tab pane."""
        try:
            from textual.widgets import DataTable
            event.pane.query_one(DataTable).focus()
        except Exception:
            pass

    def action_refresh_active(self) -> None:
        """Delegate F5 to the active tab pane's refresh action."""
        try:
            active = self.query_one(TabbedContent).active_pane
            if active:
                active.action_refresh()
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

            login(
                server_url=url,
                username=username,
                password=password,
                profile_name="default",
                db_path=self._db_path,
            )
            session = load_session(self._db_path)
            if session:
                self._username = username
                oc = CloudBeesClient(
                    session["server_url"], session["raw_token"],
                    db_path=self._db_path,
                )
                self.app.call_from_thread(setattr, self, "oc_client",    oc)
                self.app.call_from_thread(setattr, self, "ctrl_client",  oc)
                self.app.call_from_thread(setattr, self, "active_ctrl_name", "")
                self.app.call_from_thread(
                    self.notify, f"Logged in as {username}", title="Login OK"
                )
                # Reload all panes now that we have a client
                self.app.call_from_thread(self._refresh_all_panes)
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
        self._refresh_all_panes()

    def _refresh_all_panes(self) -> None:
        """Reload data in all tab panes (call on main thread after login/logout)."""
        from cb.tui.screens.controller_screen import ControllerPane
        from cb.tui.screens.credentials_screen import CredentialsPane
        from cb.tui.screens.nodes_screen import NodesPane
        from cb.tui.screens.jobs_screen import JobsPane
        from cb.tui.screens.settings_screen import SettingsPane

        for pane_cls, method in [
            (ControllerPane,  "_load_controllers"),
            (CredentialsPane, "_load_creds"),
            (NodesPane,       "_load_nodes"),
            (JobsPane,        "_load_jobs"),
            (SettingsPane,    "_load_info"),
        ]:
            try:
                pane = self.query_one(pane_cls)
                getattr(pane, method)()
            except Exception:
                pass  # pane not yet mounted -- silently skip

def _ensure_utf8() -> None:
    """Force UTF-8 for ALL file I/O in this process.

    Problem: LANG=C means Python's open() defaults to ASCII encoding.
    Textual calls open(css_file) without specifying encoding=, which then
    fails with UnicodeDecodeError when reading any file that has bytes
    outside 0x00-0x7F -- even if the file IS valid UTF-8.

    The env-var LANG trick alone does NOT fix this because locale.getpreferredencoding()
    reads the locale at process start and caches it. open() uses that cache.

    Fix chain (belt AND suspenders):
    1. os.environ: LANG, LC_ALL, PYTHONUTF8 -- for child processes
    2. locale.setlocale(LC_ALL, 'C.UTF-8') -- updates the in-process cache
    3. sys.stdout/stderr.reconfigure()    -- fixes output streams
    """
    import locale
    import os
    import sys

    active = (os.environ.get("LC_ALL") or os.environ.get("LANG") or "C").upper()
    if "UTF" in active:
        return  # already UTF-8

    # 1. Environment variables (inherited by child processes)
    os.environ["LANG"]            = "C.UTF-8"
    os.environ["LC_ALL"]          = "C.UTF-8"
    os.environ["LC_CTYPE"]        = "C.UTF-8"
    os.environ["PYTHONUTF8"]      = "1"         # Python 3.7+ UTF-8 mode
    os.environ["PYTHONIOENCODING"] = "utf-8:replace"

    # 2. Actually change the in-process locale so open() uses UTF-8
    for loc in ("C.UTF-8", "en_US.UTF-8", "UTF-8", ""):
        try:
            locale.setlocale(locale.LC_ALL, loc)
            break  # first one that works
        except locale.Error:
            continue

    # 3. Reconfigure live stdout and stderr streams
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            continue
        try:
            if hasattr(stream, "reconfigure"):       # Python 3.7+
                stream.reconfigure(encoding="utf-8", errors="replace")
            elif hasattr(stream, "buffer"):          # fallback
                import io
                setattr(sys, name,
                        io.TextIOWrapper(stream.buffer,
                                         encoding="utf-8",
                                         errors="replace",
                                         line_buffering=stream.line_buffering))
        except Exception:
            pass


def main(db_path: Optional[Path] = None) -> None:
    """Entry point called from cb/main.py."""
    _ensure_utf8()
    app = BeeApp(db_path=db_path)
    app.run()
