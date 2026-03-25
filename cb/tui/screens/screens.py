"""Controller, Credentials, Nodes, Jobs, Settings screens."""

from __future__ import annotations
import curses

from cb.tui.colors import (
    PAIR_NORMAL, PAIR_TITLE, PAIR_SUCCESS, PAIR_ERROR,
    PAIR_WARNING, PAIR_DIM, PAIR_SELECTED, PAIR_ACTIVE,
)
from cb.tui.widgets.widgets import safe_addstr, draw_table, draw_box, spinner_char
from cb.api.client import CloudBeesClient

# Screen index constants (match app.py and keys.py)
SCR_CONTROLLER  = 0
SCR_CREDENTIALS = 1
SCR_NODES       = 2
SCR_JOBS        = 3
SCR_SETTINGS    = 4


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
        if ch == curses.KEY_DOWN and self.selected < len(self.items) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch == curses.KEY_UP and self.selected > 0:
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
        if ch == curses.KEY_DOWN and self.selected < len(self.items) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch == curses.KEY_UP and self.selected > 0:
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
        if ch == curses.KEY_DOWN and self.selected < len(self.items) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch == curses.KEY_UP and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch in (curses.KEY_ENTER, ord('\n'), ord('\r')) and self.items:
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
        if ch == curses.KEY_DOWN and self.selected < len(self.jobs) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch == curses.KEY_UP and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch in (curses.KEY_ENTER, ord('\n'), ord('\r')) and self.jobs:
            return f"run_job:{self.jobs[self.selected].name}"
        return None

    def selected_job(self):
        if self.jobs and 0 <= self.selected < len(self.jobs):
            return self.jobs[self.selected]
        return None


# ── Settings screen ───────────────────────────────────────────────────────────


def draw_settings(win, client: CloudBeesClient | None) -> None:
    """Display system health and version info."""
    from cb.services.system_service import health_check, get_version
    win.erase()
    if client is None:
        safe_addstr(win, 1, 2, "Not logged in.", curses.color_pair(PAIR_WARNING))
        return

    y = 1
    safe_addstr(win, y, 2, "= Settings / System Info =",
                curses.color_pair(PAIR_TITLE) | curses.A_BOLD)
    y += 2

    ver = get_version(client)
    safe_addstr(win, y, 2, f"  Version : {ver}", curses.color_pair(PAIR_NORMAL))
    y += 1

    info = health_check(client)
    for k, v in info.items():
        safe_addstr(win, y, 2, f"  {k:<12}: {v}", curses.color_pair(PAIR_NORMAL))
        y += 1
