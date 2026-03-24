"""Main TUI application loop."""

from __future__ import annotations
import curses
import signal
from pathlib import Path

from cb.tui.colors import init_colors, PAIR_NORMAL, PAIR_STATUS
from cb.tui.keys import (
    KEY_QUIT, KEY_TAB, SCREEN_KEYS, KEY_REFRESH, KEY_CACHE,
    KEY_LOGIN, KEY_LOGOUT, HINTS, SCREEN_COUNT,
    KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_ENTER,
)
from cb.tui.widgets.widgets import draw_header, draw_sidebar, draw_statusbar


_SCREEN_NAMES = [
    "Dashboard", "Controller", "Credentials", "Nodes", "Jobs", "Users", "System"
]
_MIN_ROWS, _MIN_COLS = 24, 80
_SIDEBAR_W = 18


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
    stdscr.timeout(500)
    stdscr.keypad(True)
    has_256 = init_colors()

    # SIGWINCH — terminal resize
    _resize_flag = [False]
    def _on_resize(sig, frame):
        _resize_flag[0] = True
    signal.signal(signal.SIGWINCH, _on_resize)

    # App state
    active_screen = 0
    status_msg = f"  256-color: {'YES' if has_256 else 'no (8-color fallback)'}"
    client = None
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
        status_msg = "  Not logged in. Press 'L' to login."

    # Screen objects
    from cb.tui.screens.screens import (
        DashboardScreen, ControllerScreen, CredentialsScreen,
        NodesScreen, JobsScreen, UsersScreen, draw_system,
    )
    dash_scr  = DashboardScreen()
    ctrl_scr  = ControllerScreen()
    cred_scr  = CredentialsScreen()
    node_scr  = NodesScreen()
    jobs_scr  = JobsScreen()
    users_scr = UsersScreen()

    def _reload_current():
        nonlocal status_msg
        if client is None:
            status_msg = "  Not logged in. Press 'L' to login."
            return
        try:
            if active_screen == 1:
                ctrl_scr.load(client)
            elif active_screen == 2:
                cred_scr.load(client)
            elif active_screen == 3:
                node_scr.load(client)
            elif active_screen == 4:
                jobs_scr.load(client)
            elif active_screen == 5:
                users_scr.load(client)
            status_msg = f"  {_SCREEN_NAMES[active_screen]}"
        except Exception as exc:
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
            header_win  = stdscr.derwin(header_h,            cols,             0,         0)
            sidebar_win = stdscr.derwin(content_h,            _SIDEBAR_W,       header_h,  0)
            main_win    = stdscr.derwin(content_h,  cols - _SIDEBAR_W, header_h,  _SIDEBAR_W)
            status_win  = stdscr.derwin(statusbar_h,          cols,             rows - 1,  0)
        except curses.error:
            stdscr.refresh()
            continue

        # ── Draw ─────────────────────────────────────────────────
        server_url = active_profile.server_url if active_profile else "not connected"
        username   = active_profile.username   if active_profile else "-"

        draw_header(header_win, server_url, username)
        draw_sidebar(sidebar_win, active_screen)

        main_win.bkgd(" ", curses.color_pair(PAIR_NORMAL))
        main_win.erase()
        try:
            if active_screen == 0:
                dash_scr.draw(main_win, client)
            elif active_screen == 1:
                ctrl_scr.draw(main_win)
            elif active_screen == 2:
                cred_scr.draw(main_win)
            elif active_screen == 3:
                node_scr.draw(main_win)
            elif active_screen == 4:
                jobs_scr.draw(main_win)
            elif active_screen == 5:
                users_scr.draw(main_win)
            elif active_screen == 6:
                draw_system(main_win, client)
        except Exception as exc:
            from cb.tui.widgets.widgets import safe_addstr
            from cb.tui.colors import PAIR_ERROR
            safe_addstr(main_win, 1, 2, f"Error: {exc}", curses.color_pair(PAIR_ERROR))

        draw_statusbar(status_win, HINTS, status_msg)

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

        if ch in KEY_QUIT:
            break

        # ── Global: Left/Right arrow = prev/next screen ──────────
        if ch in KEY_LEFT:
            active_screen = (active_screen - 1) % SCREEN_COUNT
            _reload_current()
            continue

        if ch in KEY_RIGHT:
            active_screen = (active_screen + 1) % SCREEN_COUNT
            _reload_current()
            continue

        # ── Number shortcuts ─────────────────────────────────────
        if ch in SCREEN_KEYS:
            new_screen = SCREEN_KEYS[ch]
            if new_screen != active_screen:
                active_screen = new_screen
                _reload_current()
            continue

        # ── Tab = next screen ────────────────────────────────────
        if ch == KEY_TAB:
            active_screen = (active_screen + 1) % SCREEN_COUNT
            _reload_current()
            continue

        # ── Logout ────────────────────────────────────────────────
        if ch == KEY_LOGOUT:
            from cb.services.session import clear_session
            clear_session(db_path)
            client = None
            active_profile = None
            status_msg = "  Logged out. Session cleared."
            continue

        # ── Refresh / cache clear ────────────────────────────────
        if ch == KEY_REFRESH:
            from cb.cache.manager import clear_all
            clear_all(db_path)
            _reload_current()
            status_msg = "  Refreshed."
            continue

        if ch == KEY_CACHE:
            from cb.cache.manager import clear_all
            clear_all(db_path)
            status_msg = "  Cache cleared."
            continue

        # ── Login ────────────────────────────────────────────────
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
                    # Session saved by login() — load it without password
                    session = load_session(db_path)
                    if session:
                        client = CloudBeesClient(
                            session["server_url"], session["raw_token"], db_path=db_path
                        )
                    active_profile = p
                    status_msg = f"  Logged in as {p.username}"
                    _reload_current()
                except Exception as exc:
                    status_msg = f"  Login error: {exc}"
            continue

        # ── Delegate to active screen ─────────────────────────────
        action = None
        if active_screen == 0:
            action = dash_scr.handle_key(ch)
            if isinstance(action, int):
                # Dashboard returned a target screen index
                active_screen = action
                _reload_current()
                continue
        elif active_screen == 1:
            action = ctrl_scr.handle_key(ch)
        elif active_screen == 2:
            action = cred_scr.handle_key(ch)
        elif active_screen == 3:
            action = node_scr.handle_key(ch)
        elif active_screen == 4:
            action = jobs_scr.handle_key(ch)
        elif active_screen == 5:
            action = users_scr.handle_key(ch)

        if action and client:
            try:
                if isinstance(action, str) and action.startswith("run_job:"):
                    from cb.services.job_service import trigger_job
                    name = action.split(":", 1)[1]
                    trigger_job(client, name)
                    status_msg = f"  Triggered: {name}"
                elif isinstance(action, str) and action.startswith("select_controller:"):
                    from cb.services.controller_service import set_active_controller
                    name = action.split(":", 1)[1]
                    set_active_controller(name, db_path)
                    status_msg = f"  Active controller: {name}"
                elif isinstance(action, str) and action.startswith("toggle_node:"):
                    from cb.services.node_service import toggle_node
                    name = action.split(":", 1)[1]
                    toggle_node(client, name)
                    node_scr.load(client)
                    status_msg = f"  Toggled node: {name}"
            except Exception as exc:
                status_msg = f"  Error: {exc}"
