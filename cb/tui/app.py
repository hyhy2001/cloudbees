"""Main TUI application loop."""

from __future__ import annotations
import curses
import logging
import signal
from pathlib import Path

# File-based debug log — doesn't pollute the TUI terminal
logging.basicConfig(
    filename="/tmp/bee.log",
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
_log = logging.getLogger(__name__)

from cb.tui.colors import init_colors, PAIR_NORMAL, PAIR_STATUS
from cb.tui.keys import (
    KEY_QUIT, KEY_TAB, SCREEN_KEYS, KEY_REFRESH, KEY_CACHE,
    KEY_LOGIN, KEY_LOGOUT, HINTS_SIDEBAR, HINTS_CONTENT, SCREEN_COUNT,
    KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_ENTER, KEY_ESC,
)
from cb.tui.widgets.widgets import draw_header, draw_sidebar, draw_statusbar
# Screen index constants — single source of truth from screens module
from cb.tui.screens.screens import (
    SCR_CONTROLLER, SCR_CREDENTIALS,
    SCR_NODES, SCR_JOBS, SCR_SETTINGS,
)

_SCREEN_NAMES = ["Controller", "Credentials", "Nodes", "Jobs", "Settings"]
_MIN_ROWS, _MIN_COLS = 24, 80
_SIDEBAR_W = 18
_MENU_SIZE = SCREEN_COUNT + 1   # 5 screens + 1 Logout item


def main(
    stdscr,
    *,
    profile: str | None,
    controller: str | None,
    password: str | None,
    db_path: "Path | None",
) -> None:
    """curses.wrapper entry point."""
    # Terminal size guard
    rows, cols = stdscr.getmaxyx()
    if rows < _MIN_ROWS or cols < _MIN_COLS:
        stdscr.addstr(0, 0,
            f"Terminal too small. Need {_MIN_COLS}x{_MIN_ROWS}, got {cols}x{rows}.")
        stdscr.getch()
        return

    # Setup
    curses.curs_set(0)
    stdscr.timeout(100)    # 100ms tick — snappy navigation, low CPU
    stdscr.keypad(True)
    has_256 = init_colors()

    # SIGWINCH — terminal resize
    _resize_flag = [False]
    def _on_resize(sig, frame):
        _resize_flag[0] = True
    signal.signal(signal.SIGWINCH, _on_resize)

    # ── App state ────────────────────────────────────────────────
    active_screen  = SCR_CONTROLLER   # open on Controller by default
    sidebar_cursor = 0
    focus          = "sidebar"        # "sidebar" | "content"
    status_msg     = f"  256-color: {'YES' if has_256 else 'no (8-color fallback)'}"
    client         = None
    active_profile = None

    # Try loading existing session (no password needed)
    try:
        from cb.services.session import load_session
        from cb.db.connection import init_db
        init_db(db_path)
        session = load_session(db_path)
        if session and session.get("server_url"):
            from cb.api.client import CloudBeesClient
            client = CloudBeesClient(session["server_url"], session["raw_token"], db_path=db_path)
            from cb.db.repositories.profile_repo import get_default_profile
            active_profile = get_default_profile(db_path)
            status_msg = f"  Logged in as {session['username']}"
        else:
            status_msg = "  Not logged in. Press 'L' to login."
    except Exception:
        _log.exception("Session load failed")
        status_msg = "  Not logged in. Press 'L' to login."

    # Screen objects
    from cb.tui.screens.screens import (
        ControllerScreen, CredentialsScreen,
        NodesScreen, JobsScreen, draw_settings,
    )
    ctrl_scr = ControllerScreen()
    cred_scr = CredentialsScreen()
    node_scr = NodesScreen()
    jobs_scr = JobsScreen()

    # Track which screens have loaded data (lazy-load on first visit).
    # Settings (SCR_SETTINGS) renders live on each draw — no load step.
    _loaded: set[int] = set()

    def _reload_current(force: bool = False):
        nonlocal status_msg
        if client is None:
            status_msg = "  Not logged in. Press 'L' to login."
            return
        if not force and active_screen in _loaded:
            status_msg = f"  {_SCREEN_NAMES[active_screen]}"
            return
        try:
            if active_screen == SCR_CONTROLLER:
                ctrl_scr.load(client)
            elif active_screen == SCR_CREDENTIALS:
                cred_scr.load(client)
            elif active_screen == SCR_NODES:
                node_scr.load(client)
            elif active_screen == SCR_JOBS:
                jobs_scr.load(client, db_path=db_path)
            # SCR_SETTINGS: no load step
            _loaded.add(active_screen)
            status_msg = f"  {_SCREEN_NAMES[active_screen]}"
        except Exception as exc:
            _log.exception("Screen load failed (screen=%d)", active_screen)
            status_msg = f"  Error: {exc}"

    _reload_current()

    while True:
        # Handle resize
        if _resize_flag[0]:
            _resize_flag[0] = False
            curses.endwin()
            stdscr.refresh()

        rows, cols = stdscr.getmaxyx()
        if rows < _MIN_ROWS or cols < _MIN_COLS:
            stdscr.erase()
            stdscr.addstr(0, 0,
                f"Window too small ({cols}x{rows}). Resize to {_MIN_COLS}x{_MIN_ROWS}+")
            stdscr.refresh()
            ch = stdscr.getch()
            if ch in KEY_QUIT:
                break
            continue

        # ── Layout ──────────────────────────────────────────────
        header_h    = 1
        statusbar_h = 1
        content_h   = rows - header_h - statusbar_h

        try:
            header_win  = stdscr.derwin(header_h,            cols,             0,          0)
            sidebar_win = stdscr.derwin(content_h,            _SIDEBAR_W,       header_h,   0)
            main_win    = stdscr.derwin(content_h,  cols - _SIDEBAR_W, header_h,  _SIDEBAR_W)
            status_win  = stdscr.derwin(statusbar_h,          cols,             rows - 1,   0)
        except curses.error:
            stdscr.refresh()
            continue

        # ── Draw ─────────────────────────────────────────────────
        server_url = active_profile.server_url if active_profile else "not connected"
        username   = active_profile.username   if active_profile else "-"

        draw_header(header_win, server_url, username)
        draw_sidebar(sidebar_win, active_screen, cursor=sidebar_cursor, focus=focus)

        main_win.bkgd(" ", curses.color_pair(PAIR_NORMAL))
        main_win.erase()
        try:
            if client is None:
                from cb.tui.widgets.widgets import safe_addstr
                from cb.tui.colors import PAIR_WARNING, PAIR_DIM
                safe_addstr(main_win, 1, 2,
                    "  Not logged in.",
                    curses.color_pair(PAIR_WARNING) | curses.A_BOLD)
                safe_addstr(main_win, 2, 2,
                    "  Press 'L' to login.",
                    curses.color_pair(PAIR_DIM))
            elif active_screen == SCR_CONTROLLER:
                ctrl_scr.draw(main_win)
            elif active_screen == SCR_CREDENTIALS:
                cred_scr.draw(main_win)
            elif active_screen == SCR_NODES:
                node_scr.draw(main_win)
            elif active_screen == SCR_JOBS:
                jobs_scr.draw(main_win)
            elif active_screen == SCR_SETTINGS:
                draw_settings(main_win, client)
        except Exception as exc:
            _log.exception("Screen draw failed (screen=%d)", active_screen)
            from cb.tui.widgets.widgets import safe_addstr
            from cb.tui.colors import PAIR_ERROR
            safe_addstr(main_win, 1, 2, f"Error: {exc}", curses.color_pair(PAIR_ERROR))

        hints = HINTS_SIDEBAR if focus == "sidebar" else HINTS_CONTENT
        draw_statusbar(status_win, hints, status_msg)

        header_win.refresh()
        sidebar_win.refresh()
        main_win.refresh()
        status_win.refresh()

        # ── Input ─────────────────────────────────────────────────
        ch = stdscr.getch()
        if ch == -1:
            if status_msg and not status_msg.startswith("  "):
                status_msg = ""
            continue

        # ── Global keys (work in any focus) ───────────────────────
        if ch in KEY_QUIT:
            break

        if ch == KEY_LOGOUT:
            from cb.services.session import clear_session
            clear_session(db_path)
            client = None
            active_profile = None
            _loaded.clear()
            focus = "sidebar"
            status_msg = "  Logged out. Session cleared."
            continue

        if ch == KEY_LOGIN:
            from cb.tui.screens.login_screen import show_login
            url_hint = active_profile.server_url if active_profile else ""
            result = show_login(stdscr, existing_url=url_hint)
            if result:
                try:
                    from cb.services.auth_service import login
                    from cb.services.session import load_session
                    from cb.api.client import CloudBeesClient
                    from cb.db.repositories.profile_repo import get_default_profile
                    p = login(
                        server_url=result["url"],
                        username=result["username"],
                        password=result["password"],
                        profile_name=profile or "default",
                        db_path=db_path,
                    )
                    session = load_session(db_path)
                    if session:
                        client = CloudBeesClient(
                            session["server_url"], session["raw_token"], db_path=db_path
                        )
                    active_profile = p
                    _loaded.clear()
                    status_msg = f"  Logged in as {p.username}"
                    _reload_current()
                except Exception as exc:
                    status_msg = f"  Login error: {exc}"
            continue

        # ── Sidebar focus ──────────────────────────────────────────
        if focus == "sidebar":
            # ↑ / ↓ / Tab → move cursor through all menu items (screens + Logout)
            if ch == curses.KEY_UP:
                sidebar_cursor = (sidebar_cursor - 1) % _MENU_SIZE
                continue

            if ch == curses.KEY_DOWN or ch == KEY_TAB:
                sidebar_cursor = (sidebar_cursor + 1) % _MENU_SIZE
                continue

            # Enter / → → activate item
            if ch in KEY_ENTER or ch == curses.KEY_RIGHT:
                if sidebar_cursor == SCREEN_COUNT:
                    # Cursor is on Logout item
                    from cb.services.session import clear_session
                    clear_session(db_path)
                    client = None
                    active_profile = None
                    _loaded.clear()
                    status_msg = "  Logged out. Session cleared."
                else:
                    if sidebar_cursor != active_screen:
                        active_screen = sidebar_cursor
                        _reload_current()
                    focus = "content"
                continue

            # Number shortcuts 1-5 → jump + enter content immediately
            if ch in SCREEN_KEYS:
                new_screen = SCREEN_KEYS[ch]
                active_screen  = new_screen
                sidebar_cursor = new_screen
                _reload_current()
                focus = "content"
                continue

            # Refresh current screen
            if ch == KEY_REFRESH:
                _loaded.discard(active_screen)
                _reload_current(force=True)
                status_msg = "  Screen refreshed."
                continue

            # Wipe entire cache
            if ch == KEY_CACHE:
                from cb.cache.manager import clear_all
                clear_all(db_path)
                _loaded.clear()
                status_msg = "  Cache cleared."
                continue

        # ── Content focus ──────────────────────────────────────────
        elif focus == "content":
            # ← / Esc → return to sidebar
            if ch == curses.KEY_LEFT or ch in KEY_ESC:
                focus = "sidebar"
                continue

            # Refresh current screen
            if ch == KEY_REFRESH:
                _loaded.discard(active_screen)
                _reload_current(force=True)
                status_msg = "  Screen refreshed."
                continue

            # Delegate ↑↓ and all actions to the active screen
            action = None
            if active_screen == SCR_CONTROLLER:
                action = ctrl_scr.handle_key(ch)
            elif active_screen == SCR_CREDENTIALS:
                action = cred_scr.handle_key(ch)
            elif active_screen == SCR_NODES:
                action = node_scr.handle_key(ch)
            elif active_screen == SCR_JOBS:
                action = jobs_scr.handle_key(ch)

            if action and client:
                try:
                    if isinstance(action, str) and action.startswith("run_job:"):
                        from cb.services.job_service import trigger_job
                        name = action.split(":", 1)[1]
                        trigger_job(client, name)
                        status_msg = f"  Triggered: {name}"
                    elif isinstance(action, str) and action.startswith("select_controller:"):
                        from cb.services.controller_service import select_controller
                        name = action.split(":", 1)[1]
                        item = next((c for c in ctrl_scr.items if c.name == name), None)
                        url  = item.url if item and item.url else ""
                        select_controller(name, url, db_path)
                        status_msg = f"  Active controller: {name}"
                    elif isinstance(action, str) and action.startswith("toggle_node:"):
                        from cb.services.node_service import toggle_node
                        name = action.split(":", 1)[1]
                        toggle_node(client, name)
                        node_scr.load(client)
                        status_msg = f"  Toggled node: {name}"
                except Exception as exc:
                    status_msg = f"  Error: {exc}"
