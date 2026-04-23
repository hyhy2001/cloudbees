"""bee TUI -- k9s-inspired Textual interface for CloudBees CI."""

from __future__ import annotations
import logging
from pathlib import Path
from typing import Optional

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.reactive import reactive
from textual.widgets import Footer, Header, Static, TabbedContent, TabPane
from textual import work
from cb.tui.compat import SYM, UNICODE_MODE

# Context-aware footer text per tab
_CTX_HINTS: dict[str, str] = {
    "controller":  f"Enter=detail  s=select  F5=refresh  1-5=tabs  l=login  q=quit  ?=help",
    "credentials": f"c=create  d=delete  S=store  a=mine/all  F5=refresh  1-5=tabs  q=quit  ?=help",
    "nodes":       f"o=toggle  n=new  d=delete  a=mine/all  F5=refresh  1-5=tabs  q=quit  ?=help",
    "jobs":        f"r=run  s=stop  l=log  n=new  d=delete  a=mine/all  F5=refresh  1-5=tabs  q=quit  ?=help",
    "settings":    f"F5=refresh  c=clear-cache  1-5=tabs  l=login  q=quit  ?=help",
}

_log = logging.getLogger(__name__)
logging.basicConfig(
    filename="/tmp/bee.log",
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


class BeeApp(App):
    """bee CloudBees TUI — k9s-inspired terminal interface."""

    CSS_PATH = "bee.tcss"
    TITLE = "bee"
    ENABLE_COMMAND_PALETTE = False

    BINDINGS = [
        Binding("q",          "quit",                     "Quit"),
        Binding("l",          "login",                    "Login"),
        Binding("x",          "logout",                   "Logout",      show=False),
        Binding("a",          "toggle_scope",             "Mine/All",    show=False, priority=True),
        Binding("f5",         "refresh_active",           "Refresh"),
        Binding("f2",         "toggle_dark",              "Dark/Light",  show=False),
        Binding("1",          "switch_tab('controller')", "1:Ctrl",      show=False),
        Binding("2",          "switch_tab('credentials')","2:Creds",     show=False),
        Binding("3",          "switch_tab('nodes')",      "3:Nodes",     show=False),
        Binding("4",          "switch_tab('jobs')",       "4:Jobs",      show=False),
        Binding("5",          "switch_tab('settings')",   "5:Settings",  show=False),
        Binding("tab",        "next_tab",                 "Next Tab",    show=False),
        Binding("shift+tab",  "prev_tab",                 "Prev Tab",    show=False),
        Binding("right",      "next_tab",                 "→ Tab",       show=False),
        Binding("left",       "prev_tab",                 "← Tab",       show=False),
        Binding("?",          "show_help",                "Help"),
    ]

    # App-level reactive state
    oc_client:        reactive = reactive(None)
    ctrl_client:      reactive = reactive(None)
    active_ctrl_name: reactive[str] = reactive("")

    def __init__(self, db_path: Optional[Path] = None, **kwargs):
        super().__init__(**kwargs)
        self._db_path    = db_path
        self.bee_controllers = []
        self.bee_jobs        = []
        self.bee_creds       = []
        self.bee_nodes       = []
        self._username       = ""

    # ── Compose ──────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        from cb.tui.screens.controller_screen  import ControllerPane
        from cb.tui.screens.credentials_screen import CredentialsPane
        from cb.tui.screens.nodes_screen        import NodesPane
        from cb.tui.screens.jobs_screen         import JobsPane
        from cb.tui.screens.settings_screen     import SettingsPane

        yield Header(show_clock=True)
        with TabbedContent(initial="controller"):
            with TabPane("1 Controller",   id="controller"):
                yield ControllerPane()
            with TabPane("2 Credentials",  id="credentials"):
                yield CredentialsPane()
            with TabPane("3 Nodes",        id="nodes"):
                yield NodesPane()
            with TabPane("4 Jobs",         id="jobs"):
                yield JobsPane()
            with TabPane("5 Settings",     id="settings"):
                yield SettingsPane()
        yield Static("", id="ctx-footer")
        yield Footer()

    # ── Startup ───────────────────────────────────────────────

    def on_mount(self) -> None:
        try:
            bee_icon = SYM.bee if UNICODE_MODE else ">"
            self.query_one(Header).icon = bee_icon
        except Exception:
            pass
        self._restore_session()

    @work(thread=True, name="restore-session")
    def _restore_session(self) -> None:
        """Auto-login from saved session without blocking the UI."""
        try:
            from cb.db.connection import init_db
            from cb.services.session import load_session
            from cb.api.client import CloudBeesClient

            init_db(self._db_path)
            session = load_session(self._db_path)
            if not session or not session.get("server_url"):
                self.app.call_from_thread(
                    self.notify, "Not logged in — press L to login.", title="bee"
                )
                return

            self._username = session.get("username", "")
            oc = CloudBeesClient(
                session["server_url"], session["raw_token"], db_path=self._db_path
            )
            self.app.call_from_thread(setattr, self, "oc_client",   oc)
            self.app.call_from_thread(setattr, self, "ctrl_client", oc)

            from cb.services.controller_service import get_active_controller
            ctrl = get_active_controller(self._db_path, oc)
            if ctrl and ctrl[1]:
                self.app.call_from_thread(
                    setattr, self, "active_ctrl_name", ctrl[0]
                )
                new_client = CloudBeesClient(
                    base_url=ctrl[1].rstrip("/"),
                    token=oc._token,
                    db_path=self._db_path,
                )
                self.app.call_from_thread(setattr, self, "ctrl_client", new_client)

            suffix = f" [{ctrl[0]}]" if ctrl else ""
            self.app.call_from_thread(
                self.notify,
                f"Logged in as [bold]{self._username}[/bold]{suffix}",
                title="bee",
            )
            self.app.call_from_thread(self._refresh_all_panes)
        except Exception as exc:
            _log.exception("Session restore failed")
            self.app.call_from_thread(
                self.notify, f"Session error: {exc}", title="bee", severity="warning"
            )

    # ── Reactive watchers ────────────────────────────────────

    def watch_active_ctrl_name(self, name: str) -> None:
        ctrl_suffix = f"  {SYM.arrow} {name}" if name else ""
        user_part   = f"[bold]{self._username}[/bold]" if self._username else "not connected"
        self.sub_title = f"{user_part}{ctrl_suffix}"

    def watch_oc_client(self, client) -> None:
        if client and not self._username:
            self.sub_title = "connected"

    # ── Tab navigation ────────────────────────────────────────

    _TAB_ORDER = ["controller", "credentials", "nodes", "jobs", "settings"]

    def action_switch_tab(self, tab_id: str) -> None:
        self.query_one(TabbedContent).active = tab_id

    def action_next_tab(self) -> None:
        current = self.query_one(TabbedContent).active
        idx = self._TAB_ORDER.index(current) if current in self._TAB_ORDER else 0
        self.query_one(TabbedContent).active = self._TAB_ORDER[(idx + 1) % len(self._TAB_ORDER)]

    def action_prev_tab(self) -> None:
        current = self.query_one(TabbedContent).active
        idx = self._TAB_ORDER.index(current) if current in self._TAB_ORDER else 0
        self.query_one(TabbedContent).active = self._TAB_ORDER[(idx - 1) % len(self._TAB_ORDER)]

    def on_tabbed_content_tab_activated(
        self, event: TabbedContent.TabActivated
    ) -> None:
        # Update context-aware footer hint
        try:
            tab_id = self.query_one(TabbedContent).active
            hint   = _CTX_HINTS.get(tab_id, "")
            self.query_one("#ctx-footer", Static).update(
                f" [dim]{hint}[/dim]"
            )
        except Exception:
            pass
        # Defer focus to DataTable so tab switch animation completes first.
        # Using call_after_refresh avoids triggering row_selected accidentally.
        pane = event.pane
        def _focus_table() -> None:
            from textual.widgets import DataTable
            try:
                pane.query_one(DataTable).focus()
            except Exception:
                pass
        self.call_after_refresh(_focus_table)

    # ── Global actions ────────────────────────────────────────

    def action_refresh_active(self) -> None:
        try:
            active = self.query_one(TabbedContent).active_pane
            if active:
                active.action_refresh()
        except Exception:
            pass

    def action_toggle_scope(self) -> None:
        """Global Mine/All toggle for active tab; avoids key-loss when DataTable has focus."""
        # Don't intercept typing in modal/input contexts.
        try:
            from textual.screen import ModalScreen
            from textual.widgets import Input, Select, TextArea
            focused = self.focused
            if isinstance(self.screen, ModalScreen):
                return
            if isinstance(focused, (Input, Select, TextArea)):
                return
        except Exception:
            pass

        try:
            tab_id = self.query_one(TabbedContent).active
            if tab_id == "credentials":
                from cb.tui.screens.credentials_screen import CredentialsPane
                self.query_one(CredentialsPane).action_toggle_all()
            elif tab_id == "nodes":
                from cb.tui.screens.nodes_screen import NodesPane
                self.query_one(NodesPane).action_toggle_all()
            elif tab_id == "jobs":
                from cb.tui.screens.jobs_screen import JobsPane
                self.query_one(JobsPane).action_toggle_all()
        except Exception:
            pass

    def action_show_help(self) -> None:
        from cb.tui.screens.help_screen import HelpScreen
        self.push_screen(HelpScreen())

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
                    session["server_url"], session["raw_token"], db_path=self._db_path
                )
                self.app.call_from_thread(setattr, self, "oc_client",        oc)
                self.app.call_from_thread(setattr, self, "ctrl_client",       oc)
                self.app.call_from_thread(setattr, self, "active_ctrl_name", "")
                self.app.call_from_thread(setattr, self, "sub_title",
                                          f"[bold]{username}[/bold]")
                self.app.call_from_thread(
                    self.notify,
                    f"Logged in as [bold]{username}[/bold]",
                    title="Login OK",
                )
                self.app.call_from_thread(self._refresh_all_panes)
        except Exception as exc:
            self.app.call_from_thread(
                self.notify, str(exc), title="Login Failed", severity="error"
            )

    def action_logout(self) -> None:
        from cb.services.session import clear_session
        clear_session(self._db_path)
        self.oc_client        = None
        self.ctrl_client      = None
        self.active_ctrl_name = ""
        self._username        = ""
        self.sub_title        = "not connected"
        self.notify("Session cleared.", title="Logged Out")
        self._refresh_all_panes()

    def _refresh_all_panes(self) -> None:
        """Reload data in all tab panes (call on main thread)."""
        from cb.tui.screens.controller_screen  import ControllerPane
        from cb.tui.screens.credentials_screen import CredentialsPane
        from cb.tui.screens.nodes_screen        import NodesPane
        from cb.tui.screens.jobs_screen         import JobsPane
        from cb.tui.screens.settings_screen     import SettingsPane

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
                pass


# ── UTF-8 safety patch ────────────────────────────────────────

def _ensure_utf8_safe() -> None:
    """Patch builtins.open + stdio to handle invalid bytes gracefully."""
    import builtins
    import os
    import sys

    os.environ["PYTHONIOENCODING"] = "utf-8:replace"
    os.environ["PYTHONUTF8"]       = "1"

    if not getattr(builtins, "_bee_open_patched", False):
        _real_open = builtins.open

        def _safe_open(file, mode="r", buffering=-1,
                       encoding=None, errors=None, **kwargs):
            if isinstance(mode, str) and "b" not in mode:
                encoding = encoding or "utf-8"
                errors   = errors   or "replace"
            return _real_open(file, mode=mode, buffering=buffering,
                              encoding=encoding, errors=errors, **kwargs)

        builtins.open             = _safe_open
        builtins._bee_open_patched = True

    for name in ("stdout", "stderr", "stdin"):
        stream = getattr(sys, name, None)
        if stream and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def main(db_path: Optional[Path] = None) -> None:
    """Entry point called from cb/main.py."""
    _ensure_utf8_safe()
    app = BeeApp(db_path=db_path)
    app.run(mouse=False)
