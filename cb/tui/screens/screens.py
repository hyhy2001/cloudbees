"""Dashboard, Controller, Credentials, Nodes, Jobs, Users, System screens."""

from __future__ import annotations
import curses

from cb.tui.colors import (
    PAIR_NORMAL, PAIR_TITLE, PAIR_SUCCESS, PAIR_ERROR,
    PAIR_WARNING, PAIR_DIM, PAIR_SELECTED, PAIR_ACTIVE,
)
from cb.tui.widgets.widgets import safe_addstr, draw_table, draw_box, spinner_char
from cb.api.client import CloudBeesClient

# Screen index constants (match app.py and keys.py)
SCR_DASHBOARD   = 0
SCR_CONTROLLER  = 1
SCR_CREDENTIALS = 2
SCR_NODES       = 3
SCR_JOBS        = 4
SCR_USERS       = 5
SCR_SYSTEM      = 6

# Dashboard menu entries → target screen index
_DASH_MENU = [
    ("Controller",   SCR_CONTROLLER),
    ("Credentials",  SCR_CREDENTIALS),
    ("Nodes",        SCR_NODES),
    ("Jobs",         SCR_JOBS),
    ("Users",        SCR_USERS),
    ("System",       SCR_SYSTEM),
]


# ── Dashboard (interactive menu) ─────────────────────────────────────────────


class DashboardScreen:
    def __init__(self):
        self.selected = 0          # kept for compat, not used for nav

    def draw(self, win, client: CloudBeesClient | None) -> None:
        win.erase()
        rows, cols = win.getmaxyx()
        y = 1

        if client is None:
            safe_addstr(win, y, 2,
                "  Not logged in.",
                curses.color_pair(PAIR_WARNING) | curses.A_BOLD)
            y += 1
            safe_addstr(win, y, 2,
                "  Press 'L' to open the login form.",
                curses.color_pair(PAIR_DIM))
            return

        # Logged-in welcome
        safe_addstr(win, y, 2, "  bee - CloudBees CLI",
                    curses.color_pair(PAIR_TITLE) | curses.A_BOLD); y += 1
        safe_addstr(win, y, 2, "  " + "-" * 40,
                    curses.color_pair(PAIR_DIM)); y += 2

        try:
            from cb.services.system_service import health_check
            info = health_check(client)
            status_color = PAIR_SUCCESS if info.get("status") == "OK" else PAIR_ERROR
            safe_addstr(win, y, 4, f"Status      : {info.get('status','?')}",
                        curses.color_pair(status_color) | curses.A_BOLD); y += 1
            safe_addstr(win, y, 4, f"Mode        : {info.get('mode','?')}",
                        curses.color_pair(PAIR_NORMAL)); y += 1
            safe_addstr(win, y, 4, f"Executors   : {info.get('executors','?')}",
                        curses.color_pair(PAIR_NORMAL)); y += 1
            safe_addstr(win, y, 4, f"Description : {info.get('description','')}",
                        curses.color_pair(PAIR_NORMAL)); y += 2
        except Exception as e:
            safe_addstr(win, y, 4, f"(could not fetch status: {e})",
                        curses.color_pair(PAIR_DIM)); y += 2

        safe_addstr(win, y, 2,
            "  Use sidebar (1-7) or Tab / Left-Right to navigate.",
            curses.color_pair(PAIR_DIM))

    def handle_key(self, ch: int) -> int | None:
        return None   # dashboard no longer handles Enter-to-navigate


# ── Controller screen ────────────────────────────────────────────────────────


class ControllerScreen:
    def __init__(self):
        self.items = []
        self.selected = 0
        self.offset = 0

    def load(self, client: CloudBeesClient) -> None:
        try:
            from cb.services.controller_service import list_controllers
            self.items = list_controllers(client)
        except Exception:
            self.items = []

    def draw(self, win) -> None:
        headers = ["Name", "Online", "URL"]
        rows = [
            [c.name[:28], "YES" if c.online else "NO", (c.url or "")[:40]]
            for c in self.items
        ]
        draw_table(win, headers, rows, self.selected, self.offset)

    def handle_key(self, ch: int) -> str | None:
        if ch in (curses.KEY_DOWN, ord('j')) and self.selected < len(self.items) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch in (curses.KEY_UP, ord('k')) and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch in (curses.KEY_ENTER, ord('\n'), ord('\r')) and self.items:
            return f"select_controller:{self.items[self.selected].name}"
        return None


# ── Credentials screen ────────────────────────────────────────────────────────


class CredentialsScreen:
    def __init__(self):
        self.items = []
        self.selected = 0
        self.offset = 0

    def load(self, client: CloudBeesClient) -> None:
        try:
            from cb.services.credential_service import list_credentials
            self.items = list_credentials(client)
        except Exception:
            self.items = []

    def draw(self, win) -> None:
        headers = ["ID", "Type", "Scope"]
        rows = [
            [c.id[:25], c.type_name[:20], c.scope[:12]]
            for c in self.items
        ]
        draw_table(win, headers, rows, self.selected, self.offset)

    def handle_key(self, ch: int) -> str | None:
        if ch in (curses.KEY_DOWN, ord('j')) and self.selected < len(self.items) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch in (curses.KEY_UP, ord('k')) and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        return None


# ── Nodes screen ──────────────────────────────────────────────────────────────


class NodesScreen:
    def __init__(self):
        self.items = []
        self.selected = 0
        self.offset = 0

    def load(self, client: CloudBeesClient) -> None:
        try:
            from cb.services.node_service import list_nodes
            self.items = list_nodes(client)
        except Exception:
            self.items = []

    def draw(self, win) -> None:
        headers = ["Name", "Status", "Executors", "Labels"]
        rows = [
            [
                n.name[:25],
                "OFFLINE" if n.offline else "ONLINE",
                str(n.num_executors),
                " ".join(n.labels)[:25],
            ]
            for n in self.items
        ]
        draw_table(win, headers, rows, self.selected, self.offset)

    def handle_key(self, ch: int) -> str | None:
        if ch in (curses.KEY_DOWN, ord('j')) and self.selected < len(self.items) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch in (curses.KEY_UP, ord('k')) and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch == ord('o') and self.items:
            node = self.items[self.selected]
            return f"toggle_node:{node.name}"
        return None


# ── Jobs screen ───────────────────────────────────────────────────────────────


class JobsScreen:
    def __init__(self):
        self.jobs = []
        self.selected = 0
        self.offset = 0
        self.loading = False

    def load(self, client: CloudBeesClient, db_path=None) -> None:
        from cb.services.job_service import list_jobs
        self.loading = True
        try:
            self.jobs = list_jobs(client, db_path=db_path)
        finally:
            self.loading = False

    def draw(self, win) -> None:
        if self.loading:
            safe_addstr(win, 1, 2, f"Loading {spinner_char()}",
                        curses.color_pair(PAIR_DIM))
            return
        headers = ["Type", "Name", "Status", "Build#"]
        rows = [
            [
                getattr(j, "job_type", "??"),
                j.name[:28],
                j.color[:12],
                str(j.last_build_number or "-"),
            ]
            for j in self.jobs
        ]
        draw_table(win, headers, rows, self.selected, self.offset)

    def handle_key(self, ch: int) -> str | None:
        if ch in (curses.KEY_DOWN, ord('j')) and self.selected < len(self.jobs) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch in (curses.KEY_UP, ord('k')) and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch == ord('r') and self.jobs:
            return f"run_job:{self.jobs[self.selected].name}"
        elif ch in (curses.KEY_ENTER, ord('\n'), ord('\r')) and self.jobs:
            return f"detail_job:{self.jobs[self.selected].name}"
        return None

    def selected_job(self):
        if self.jobs and 0 <= self.selected < len(self.jobs):
            return self.jobs[self.selected]
        return None


# ── Users screen ──────────────────────────────────────────────────────────────


class UsersScreen:
    def __init__(self):
        self.users = []
        self.selected = 0
        self.offset = 0

    def load(self, client: CloudBeesClient) -> None:
        from cb.services.user_service import list_users
        self.users = list_users(client)

    def draw(self, win) -> None:
        headers = ["ID", "Full Name", "Description"]
        rows = [
            [u.id[:20], u.full_name[:25], (u.description or "")[:35]]
            for u in self.users
        ]
        draw_table(win, headers, rows, self.selected, self.offset)

    def handle_key(self, ch: int) -> str | None:
        if ch in (curses.KEY_DOWN, ord('j')) and self.selected < len(self.users) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch in (curses.KEY_UP, ord('k')) and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        return None


# ── System screen ─────────────────────────────────────────────────────────────


def draw_system(win, client: CloudBeesClient | None) -> None:
    from cb.services.system_service import health_check, get_version
    win.erase()
    if client is None:
        safe_addstr(win, 1, 2, "Not logged in.", curses.color_pair(PAIR_WARNING))
        return

    y = 1
    safe_addstr(win, y, 2, "= System Info =",
                curses.color_pair(PAIR_TITLE) | curses.A_BOLD)
    y += 2

    ver = get_version(client)
    safe_addstr(win, y, 2, f"  Version : {ver}", curses.color_pair(PAIR_NORMAL))
    y += 1

    info = health_check(client)
    for k, v in info.items():
        safe_addstr(win, y, 2, f"  {k:<12}: {v}", curses.color_pair(PAIR_NORMAL))
        y += 1


# Keep for backward compat
PipelinesScreen = None  # removed
