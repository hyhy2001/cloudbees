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


# ── Helpers ───────────────────────────────────────────────────────────────────


def _draw_detail_panel(win, title: str, rows: list[tuple[str, str]]) -> None:
    """Draw a simple two-column detail panel (label: value)."""
    win.erase()
    max_rows, cols = win.getmaxyx()
    safe_addstr(win, 0, 2, f"  {title}  ",
                curses.color_pair(PAIR_TITLE) | curses.A_BOLD | curses.A_UNDERLINE)
    safe_addstr(win, 1, 2, "─" * (cols - 4), curses.color_pair(PAIR_DIM))
    for i, (label, value) in enumerate(rows):
        if i + 3 >= max_rows:
            break
        safe_addstr(win, i + 2, 4, f"{label:<16}", curses.color_pair(PAIR_DIM))
        safe_addstr(win, i + 2, 20, value[:cols - 22], curses.color_pair(PAIR_NORMAL) | curses.A_BOLD)
    safe_addstr(win, min(len(rows) + 3, max_rows - 2), 4,
                "← / Esc to go back", curses.color_pair(PAIR_DIM))


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
        self.offset   = 0
        self.detail_mode = False
        self.detail_item = None

    def load(self, client: CloudBeesClient) -> None:
        try:
            from cb.services.credential_service import list_credentials
            self.items = list_credentials(client)
        except Exception:
            self.items = []

    def draw(self, win) -> None:
        if self.detail_mode and self.detail_item:
            c = self.detail_item
            _draw_detail_panel(win, "Credential Detail", [
                ("ID",          c.id),
                ("Name",        c.display_name),
                ("Type",        c.type_name),
                ("Scope",       c.scope),
                ("Description", c.description or "—"),
            ])
        else:
            headers = ["ID", "Display Name", "Type", "Scope"]
            rows = [
                [c.id[:20], c.display_name[:22], c.type_name[:18], c.scope[:10]]
                for c in self.items
            ]
            draw_table(win, headers, rows, self.selected, self.offset)

    def handle_key(self, ch: int) -> str | None:
        if self.detail_mode:
            if ch in (curses.KEY_LEFT, 27, ord('\x1b')):
                self.detail_mode = False
            return None

        if ch == curses.KEY_DOWN and self.selected < len(self.items) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch == curses.KEY_UP and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch in (curses.KEY_ENTER, ord('\n'), ord('\r')) and self.items:
            self.detail_item = self.items[self.selected]
            self.detail_mode = True
        return None


# ── Nodes screen ──────────────────────────────────────────────────────────────


class NodesScreen:
    def __init__(self):
        self.items         = []
        self.selected      = 0
        self.offset        = 0
        self.pending_toggle: str | None = None   # node name awaiting confirm

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
                (n.labels if isinstance(n.labels, str) else " ".join(n.labels))[:22],
            ]
            for n in self.items
        ]
        # Colour rows by online state
        row_attrs = [
            curses.color_pair(PAIR_ERROR)   if n.offline
            else curses.color_pair(PAIR_SUCCESS)
            for n in self.items
        ]
        draw_table(win, headers, rows, self.selected, self.offset, row_attrs=row_attrs)

        # Confirmation prompt overlay at bottom of win
        if self.pending_toggle:
            max_rows, cols = win.getmaxyx()
            prompt = f"  Toggle '{self.pending_toggle}'?  Enter=confirm   ←/Esc=cancel  "
            safe_addstr(win, max_rows - 2, 2, prompt[:cols - 3],
                        curses.color_pair(PAIR_WARNING) | curses.A_BOLD)

    def handle_key(self, ch: int) -> str | None:
        # Confirmation state
        if self.pending_toggle:
            if ch in (curses.KEY_ENTER, ord('\n'), ord('\r')):
                name = self.pending_toggle
                self.pending_toggle = None
                return f"toggle_node:{name}"
            else:
                self.pending_toggle = None
            return None

        if ch == curses.KEY_DOWN and self.selected < len(self.items) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch == curses.KEY_UP and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch in (curses.KEY_ENTER, ord('\n'), ord('\r')) and self.items:
            self.pending_toggle = self.items[self.selected].name
        return None


# ── Jobs screen ───────────────────────────────────────────────────────────────


_JOB_STATUS_ICON = {
    "blue":          "✅",
    "blue_anime":    "🔄",
    "red":           "❌",
    "red_anime":     "🔄",
    "yellow":        "⚠️",
    "yellow_anime":  "🔄",
    "aborted":       "⚫",
    "aborted_anime": "🔄",
    "notbuilt":      "⬜",
    "disabled":      "🚫",
    "":              "⬜",
}

_JOB_STATUS_PAIR = {
    "blue":     PAIR_SUCCESS,
    "red":      PAIR_ERROR,
    "yellow":   PAIR_WARNING,
    "aborted":  PAIR_DIM,
    "disabled": PAIR_DIM,
    "notbuilt": PAIR_DIM,
}


class JobsScreen:
    def __init__(self):
        self.jobs          = []
        self.selected      = 0
        self.offset        = 0
        self.loading       = False
        self.pending_run: str | None = None   # job name awaiting confirm

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

        headers = ["Type", "Status", "Name", "Build#"]
        rows = []
        row_attrs = []
        for j in self.jobs:
            icon = _JOB_STATUS_ICON.get(j.color, "  ")
            rows.append([
                j.job_type or "??",
                f"{icon} {j.color[:8]}",
                j.name[:28],
                str(j.last_build_number or "-"),
            ])
            pair = _JOB_STATUS_PAIR.get(j.color.replace("_anime", ""), PAIR_NORMAL)
            row_attrs.append(curses.color_pair(pair))

        draw_table(win, headers, rows, self.selected, self.offset, row_attrs=row_attrs)

        # Confirmation prompt
        if self.pending_run:
            max_rows, cols = win.getmaxyx()
            prompt = f"  Run '{self.pending_run}'?  Enter=confirm   ←/Esc=cancel  "
            safe_addstr(win, max_rows - 2, 2, prompt[:cols - 3],
                        curses.color_pair(PAIR_WARNING) | curses.A_BOLD)

    def handle_key(self, ch: int) -> str | None:
        # Confirmation state
        if self.pending_run:
            if ch in (curses.KEY_ENTER, ord('\n'), ord('\r')):
                name = self.pending_run
                self.pending_run = None
                return f"run_job:{name}"
            else:
                self.pending_run = None
            return None

        if ch == curses.KEY_DOWN and self.selected < len(self.jobs) - 1:
            self.selected += 1
            if self.selected >= self.offset + 15:
                self.offset += 1
        elif ch == curses.KEY_UP and self.selected > 0:
            self.selected -= 1
            if self.selected < self.offset:
                self.offset -= 1
        elif ch in (curses.KEY_ENTER, ord('\n'), ord('\r')) and self.jobs:
            self.pending_run = self.jobs[self.selected].name
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
