"""Reusable TUI widgets — header, sidebar, table, input box, statusbar."""

from __future__ import annotations
import curses
import time

from cb.tui.colors import (
    PAIR_HEADER, PAIR_SIDEBAR, PAIR_SELECTED, PAIR_STATUS,
    PAIR_NORMAL, PAIR_ACTIVE, PAIR_INPUT, PAIR_KEYHINT, PAIR_TITLE,
    PAIR_SUCCESS, PAIR_ERROR, PAIR_WARNING, PAIR_DIM,
)


# ── ASCII border helpers ──────────────────────────────────────


def safe_addstr(win, y: int, x: int, text: str, attr: int = 0) -> None:
    """addstr that silently swallows the curses exception at window edge."""
    try:
        win.addstr(y, x, text, attr)
    except curses.error:
        pass


def draw_hline(win, y: int, x: int, width: int, char: str = "-") -> None:
    safe_addstr(win, y, x, char * width)


def draw_box(win, y: int, x: int, h: int, w: int, attr: int = 0) -> None:
    """Draw an ASCII box with + - | corners."""
    border = "+" + "-" * (w - 2) + "+"
    mid = "|" + " " * (w - 2) + "|"
    safe_addstr(win, y, x, border, attr)
    for row in range(1, h - 1):
        safe_addstr(win, y + row, x, mid, attr)
    safe_addstr(win, y + h - 1, x, border, attr)


# ── Header ────────────────────────────────────────────────────


def draw_header(win, server_url: str, username: str, active_ctrl: str = "") -> None:
    rows, cols = win.getmaxyx()
    win.bkgd(" ", curses.color_pair(PAIR_HEADER))
    title = " CloudBees Manager"
    ctrl_badge = f"  │  ctrl: {active_ctrl}" if active_ctrl else ""
    right = f"[{username}]  {server_url} "
    gap = cols - len(title) - len(ctrl_badge) - len(right)
    line = title + ctrl_badge + " " * max(gap, 1) + right
    safe_addstr(win, 0, 0, line[:cols - 1], curses.color_pair(PAIR_HEADER) | curses.A_BOLD)


# ── Sidebar ───────────────────────────────────────────────────

MENU_ITEMS = [
    "[1] Controller",
    "[2] Credentials",
    "[3] Nodes",
    "[4] Jobs",
    "[5] Settings",
    "[-] Logout",
]


def draw_sidebar(win, active_idx: int, cursor: int | None = None, focus: str = "sidebar") -> None:
    rows, cols = win.getmaxyx()
    win.bkgd(" ", curses.color_pair(PAIR_SIDEBAR))
    win.erase()

    for i, label in enumerate(MENU_ITEMS):
        is_active = (i == active_idx)
        is_cursor = (cursor is not None and i == cursor)

        if focus == "content":
            # Content panel is active — dim the entire sidebar
            attr   = curses.color_pair(PAIR_DIM)
            prefix = "> " if is_active else "  "
        elif is_active and is_cursor:
            # Cursor resting on the already-active screen — show combined state
            attr   = curses.color_pair(PAIR_ACTIVE) | curses.A_BOLD | curses.A_REVERSE
            prefix = "> "
        elif is_active:
            # This screen is showing in content, cursor is elsewhere
            attr   = curses.color_pair(PAIR_ACTIVE) | curses.A_BOLD
            prefix = "> "
        elif is_cursor:
            # Cursor hovering here (not yet confirmed with Enter)
            attr   = curses.color_pair(PAIR_SELECTED)
            prefix = "> "
        else:
            attr   = curses.color_pair(PAIR_SIDEBAR)
            prefix = "  "

        safe_addstr(win, i + 1, 0, f"{prefix}{label:<{cols - 3}}", attr)

    # Separator line
    for r in range(rows):
        safe_addstr(win, r, cols - 1, "|", curses.color_pair(PAIR_DIM))


# ── Status bar ────────────────────────────────────────────────


def draw_statusbar(win, hints: str, message: str = "") -> None:
    rows, cols = win.getmaxyx()
    win.bkgd(" ", curses.color_pair(PAIR_STATUS))
    win.erase()
    text = message if message else hints
    safe_addstr(win, 0, 1, text[:cols - 2], curses.color_pair(PAIR_KEYHINT))


# ── ASCII Table ───────────────────────────────────────────────


def draw_table(
    win,
    headers: list[str],
    rows: list[list[str]],
    selected: int = 0,
    offset: int = 0,
    cache_age: str = "",
    row_attrs: list[int] | None = None,
) -> None:
    """
    Draw a scrollable ASCII table inside win.

    row_attrs: optional per-row curses attr (e.g. PAIR_SUCCESS for ONLINE nodes).
               When a row is selected, PAIR_SELECTED overrides row_attrs.
    """
    max_rows, cols = win.getmaxyx()
    win.bkgd(" ", curses.color_pair(PAIR_NORMAL))
    win.erase()

    if not rows:
        safe_addstr(win, 1, 2, "(no data)", curses.color_pair(PAIR_DIM))
        return

    # Compute column widths
    n_cols = len(headers)
    avail = max(cols - n_cols - 1, n_cols * 4)
    widths = [max(4, len(h)) for h in headers]
    for row in rows:
        for i, cell in enumerate(row[:n_cols]):
            widths[i] = max(widths[i], len(str(cell)))

    # Scale down if too wide — distribute shrink from largest to smallest
    total = sum(widths) + n_cols + 1
    if total > cols - 1:
        excess = total - (cols - 1)
        for i in range(n_cols - 1, -1, -1):
            can_shrink = widths[i] - 4
            if can_shrink <= 0:
                continue
            shrink = min(can_shrink, excess)
            widths[i] -= shrink
            excess -= shrink
            if excess <= 0:
                break

    sep = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    fmt_parts = [f" {{:<{w}}} " for w in widths]

    def make_row(cells: list[str]) -> str:
        padded = [str(cells[i]) if i < len(cells) else "" for i in range(n_cols)]
        return "|" + "|".join(p.format(c[:w]) for p, c, w in zip(fmt_parts, padded, widths)) + "|"

    y = 0
    # Header
    if y < max_rows - 1:
        safe_addstr(win, y, 0, sep[:cols - 1], curses.color_pair(PAIR_DIM)); y += 1
    if y < max_rows - 1:
        safe_addstr(win, y, 0, make_row(headers)[:cols - 1],
                    curses.color_pair(PAIR_TITLE) | curses.A_BOLD | curses.A_UNDERLINE); y += 1
    if y < max_rows - 1:
        safe_addstr(win, y, 0, sep[:cols - 1], curses.color_pair(PAIR_DIM)); y += 1

    # Rows
    visible_rows = rows[offset:]
    for idx, row in enumerate(visible_rows):
        if y >= max_rows - 2:
            break
        real_idx = idx + offset
        if real_idx == selected:
            attr = curses.color_pair(PAIR_SELECTED) | curses.A_BOLD
        elif row_attrs and real_idx < len(row_attrs):
            attr = row_attrs[real_idx]
        else:
            attr = curses.color_pair(PAIR_NORMAL)

        row_text = make_row([str(c) for c in row])
        safe_addstr(win, y, 0, row_text[:cols - 1], attr)
        y += 1

    if y < max_rows - 1:
        safe_addstr(win, y, 0, sep[:cols - 1], curses.color_pair(PAIR_DIM)); y += 1

    # Footer
    count_text = f"  {len(rows)} item(s)"
    if cache_age:
        count_text += f"  (cached {cache_age})"
    safe_addstr(win, y, 0, count_text, curses.color_pair(PAIR_DIM))


# ── Input Box ─────────────────────────────────────────────────


def draw_input_box(win, y: int, x: int, label: str, value: str,
                   width: int = 40, secret: bool = False, active: bool = False) -> None:
    """Draw a labelled ASCII input box."""
    display = "*" * len(value) if secret else value
    attr = curses.color_pair(PAIR_INPUT) | (curses.A_BOLD if active else 0)

    safe_addstr(win, y,     x, f"  {label}", curses.color_pair(PAIR_DIM))
    safe_addstr(win, y + 1, x, "+" + "-" * (width + 2) + "+", curses.color_pair(PAIR_DIM))
    field = f"| {display:<{width}} |"
    safe_addstr(win, y + 2, x, field, attr)
    safe_addstr(win, y + 3, x, "+" + "-" * (width + 2) + "+", curses.color_pair(PAIR_DIM))


# ── Spinner ───────────────────────────────────────────────────

_SPINNER = r"|/-\\"


def spinner_char() -> str:
    return _SPINNER[int(time.time() * 4) % len(_SPINNER)]
