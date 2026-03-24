"""Dashboard, Jobs, Pipelines, Users, System screens."""

from __future__ import annotations
import curses

from cb.tui.colors import (
    PAIR_NORMAL, PAIR_TITLE, PAIR_SUCCESS, PAIR_ERROR,
    PAIR_WARNING, PAIR_DIM, PAIR_SELECTED,
)
from cb.tui.widgets.widgets import safe_addstr, draw_table, draw_box, spinner_char
from cb.api.client import CloudBeesClient


# ── Dashboard ─────────────────────────────────────────────────


def draw_dashboard(win, client: CloudBeesClient | None) -> None:
    from cb.services.system_service import health_check
    win.erase()
    if client is None:
        safe_addstr(win, 1, 2, "Not logged in. Press 'l' to login.",
                    curses.color_pair(PAIR_WARNING) | curses.A_BOLD)
        return

    info = health_check(client)
    rows, cols = win.getmaxyx()
    y = 1

    safe_addstr(win, y, 2, "= Dashboard =", curses.color_pair(PAIR_TITLE) | curses.A_BOLD); y += 2

    status_color = PAIR_SUCCESS if info.get("status") == "OK" else PAIR_ERROR
    safe_addstr(win, y, 2, f"  Status      : {info.get('status', '?')}",
                curses.color_pair(status_color) | curses.A_BOLD); y += 1
    safe_addstr(win, y, 2, f"  Mode        : {info.get('mode', '?')}",
                curses.color_pair(PAIR_NORMAL)); y += 1
    safe_addstr(win, y, 2, f"  Description : {info.get('description', '?')}",
                curses.color_pair(PAIR_NORMAL)); y += 1
    safe_addstr(win, y, 2, f"  Executors   : {info.get('executors', '?')}",
                curses.color_pair(PAIR_NORMAL)); y += 2

    safe_addstr(win, y, 2, "  Press 2 for Jobs, 3 for Pipelines, 4 for Users",
                curses.color_pair(PAIR_DIM))


# ── Jobs screen ───────────────────────────────────────────────


class JobsScreen:
    def __init__(self):
        self.jobs = []
        self.selected = 0
        self.offset = 0
        self.loading = False

    def load(self, client: CloudBeesClient) -> None:
        from cb.services.job_service import list_jobs
        self.loading = True
        try:
            self.jobs = list_jobs(client)
        finally:
            self.loading = False

    def draw(self, win) -> None:
        if self.loading:
            safe_addstr(win, 1, 2, f"Loading {spinner_char()}",
                        curses.color_pair(PAIR_DIM))
            return
        headers = ["Name", "Status", "Build#", "Description"]
        rows = [
            [j.name[:28], j.color[:12],
             str(j.last_build_number or "-"),
             (j.description or "")[:30]]
            for j in self.jobs
        ]
        draw_table(win, headers, rows, self.selected, self.offset)

    def handle_key(self, ch: int) -> str | None:
        """Returns action string or None."""
        if ch == curses.KEY_DOWN and self.selected < len(self.jobs) - 1:
            self.selected += 1
            rows, _ = 20, 80
            if self.selected >= self.offset + rows - 5:
                self.offset += 1
        elif ch == curses.KEY_UP and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch == ord('r') and self.jobs:
            return f"run_job:{self.jobs[self.selected].name}"
        return None

    def selected_job(self):
        if self.jobs and 0 <= self.selected < len(self.jobs):
            return self.jobs[self.selected]
        return None


# ── Pipelines screen ──────────────────────────────────────────


class PipelinesScreen:
    def __init__(self):
        self.pipelines = []
        self.selected = 0
        self.offset = 0

    def load(self, client: CloudBeesClient) -> None:
        from cb.services.pipeline_service import list_pipelines
        self.pipelines = list_pipelines(client)

    def draw(self, win) -> None:
        headers = ["Name", "Status", "Branch", "Description"]
        rows = [
            [p.name[:28], p.status[:12], p.branch[:15], (p.description or "")[:25]]
            for p in self.pipelines
        ]
        draw_table(win, headers, rows, self.selected, self.offset)

    def handle_key(self, ch: int) -> str | None:
        if ch == curses.KEY_DOWN and self.selected < len(self.pipelines) - 1:
            self.selected += 1
        elif ch == curses.KEY_UP and self.selected > 0:
            self.selected -= 1
        elif ch == ord('r') and self.pipelines:
            return f"run_pipeline:{self.pipelines[self.selected].name}"
        return None


# ── Users screen ──────────────────────────────────────────────


class UsersScreen:
    def __init__(self):
        self.users = []
        self.selected = 0

    def load(self, client: CloudBeesClient) -> None:
        from cb.services.user_service import list_users
        self.users = list_users(client)

    def draw(self, win) -> None:
        headers = ["ID", "Full Name", "Description"]
        rows = [
            [u.id[:20], u.full_name[:25], (u.description or "")[:35]]
            for u in self.users
        ]
        draw_table(win, headers, rows, self.selected, 0)

    def handle_key(self, ch: int) -> str | None:
        if ch == curses.KEY_DOWN and self.selected < len(self.users) - 1:
            self.selected += 1
        elif ch == curses.KEY_UP and self.selected > 0:
            self.selected -= 1
        return None


# ── System screen ─────────────────────────────────────────────


def draw_system(win, client: CloudBeesClient | None) -> None:
    from cb.services.system_service import health_check, get_version
    win.erase()
    if client is None:
        safe_addstr(win, 1, 2, "Not logged in.", curses.color_pair(PAIR_WARNING))
        return

    y = 1
    safe_addstr(win, y, 2, "= System Info =", curses.color_pair(PAIR_TITLE) | curses.A_BOLD)
    y += 2

    ver = get_version(client)
    safe_addstr(win, y, 2, f"  Version : {ver}", curses.color_pair(PAIR_NORMAL)); y += 1

    info = health_check(client)
    for k, v in info.items():
        safe_addstr(win, y, 2, f"  {k:<12}: {v}", curses.color_pair(PAIR_NORMAL)); y += 1
