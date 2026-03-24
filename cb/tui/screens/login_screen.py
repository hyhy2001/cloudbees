"""Login screen — collects URL, username, password."""

from __future__ import annotations
import curses

from cb.tui.colors import (
    PAIR_TITLE, PAIR_ERROR, PAIR_HEADER,
    PAIR_NORMAL, PAIR_DIM, PAIR_INPUT, PAIR_SELECTED,
)
from cb.tui.widgets.widgets import safe_addstr
from cb.tui.keys import KEY_ENTER, KEY_ESC

# Total box width (including the two | walls)
BOX_W  = 56
# Inner content width = BOX_W - 4  (walls + 1 space padding each side)
INNER  = BOX_W - 4


def _fill_bg(stdscr) -> None:
    rows, cols = stdscr.getmaxyx()
    blank = " " * (cols - 1)
    attr  = curses.color_pair(PAIR_NORMAL)
    for r in range(rows):
        try:
            stdscr.addstr(r, 0, blank, attr)
        except curses.error:
            pass


def _row(content: str) -> str:
    """Pad content to fill a full box row: |  content  |"""
    return f"|  {content:<{INNER}}  |"


def _sep() -> str:
    return "+" + "-" * (BOX_W - 2) + "+"


def _draw_field(stdscr, y: int, cx: int, field: dict, is_active: bool) -> None:
    """Draw a single labeled input field — same style regardless of active."""
    marker     = ">" if is_active else " "
    label_attr = curses.color_pair(PAIR_DIM)
    box_attr   = curses.color_pair(PAIR_NORMAL)
    val_attr   = curses.color_pair(PAIR_INPUT)

    safe_addstr(stdscr, y,     cx, _row(f"{marker} {field['label']}:"), label_attr)
    safe_addstr(stdscr, y + 1, cx, f"|  +{'-' * INNER}+  |", box_attr)
    display = "*" * len(field["value"]) if field["secret"] else field["value"]
    display = display[-INNER:] if len(display) > INNER else display
    safe_addstr(stdscr, y + 2, cx, f"|  |{display:<{INNER}}|  |", val_attr)
    safe_addstr(stdscr, y + 3, cx, f"|  +{'-' * INNER}+  |", box_attr)


def show_login(stdscr, existing_url: str = "") -> dict | None:
    """
    Interactive login form.
    Returns {url, username, password} or None if cancelled.
    """
    curses.curs_set(1)
    fields = [
        {"label": "Server URL",  "value": existing_url, "secret": False},
        {"label": "Username",    "value": "",            "secret": False},
        {"label": "Password",    "value": "",            "secret": True},
    ]
    active = 0
    error  = ""

    while True:
        rows, cols = stdscr.getmaxyx()
        cx = max(0, cols // 2 - BOX_W // 2)

        # Box height: title(3) + spacer(1) + 3 fields * 5 rows + spacer(1) + hint(1) + bottom(1)
        box_h = 3 + 1 + len(fields) * 5 + 2 + 1
        cy = max(0, rows // 2 - box_h // 2)

        # Background
        _fill_bg(stdscr)

        border_attr = curses.color_pair(PAIR_HEADER) | curses.A_BOLD
        hint_attr   = curses.color_pair(PAIR_TITLE)
        dim_attr    = curses.color_pair(PAIR_DIM)

        y = cy

        # ── Top border ──
        safe_addstr(stdscr, y, cx, _sep(), border_attr); y += 1

        # ── Title ──
        title = "  bee - Login to CloudBees  "
        safe_addstr(stdscr, y, cx, _row(title.center(INNER)), border_attr | curses.A_BOLD); y += 1
        safe_addstr(stdscr, y, cx, _sep(), border_attr); y += 1

        # ── Spacer ──
        safe_addstr(stdscr, y, cx, _row(""), dim_attr); y += 1

        # ── Fields ──
        field_y_positions = []
        for i, field in enumerate(fields):
            field_y_positions.append(y)
            _draw_field(stdscr, y, cx, field, is_active=(i == active))
            safe_addstr(stdscr, y + 4, cx, _row(""), dim_attr)
            y += 5

        # ── Error / hint ──
        if error:
            safe_addstr(stdscr, y, cx,
                _row(f"[!] {error}"),
                curses.color_pair(PAIR_ERROR) | curses.A_BOLD)
        else:
            safe_addstr(stdscr, y, cx, _row(""), dim_attr)
        y += 1

        safe_addstr(stdscr, y, cx,
            _row("Tab=Next  Up=Prev  Enter=Login  Esc=Cancel"),
            hint_attr); y += 1

        # ── Bottom border ──
        safe_addstr(stdscr, y, cx, _sep(), border_attr)

        # ── Cursor inside active field value ──
        val_y = field_y_positions[active] + 2
        display = fields[active]["value"]
        if fields[active]["secret"]:
            display = "*" * len(display)
        val_x = cx + 3 + min(len(display), INNER)
        try:
            stdscr.move(val_y, val_x)
        except curses.error:
            pass

        stdscr.refresh()
        ch = stdscr.getch()

        if ch in KEY_ESC:
            curses.curs_set(0)
            return None

        if ch in (curses.KEY_DOWN, ord("\t")):
            active = (active + 1) % len(fields)
            error  = ""

        elif ch == curses.KEY_UP:
            active = (active - 1) % len(fields)
            error  = ""

        elif ch in KEY_ENTER:
            url      = fields[0]["value"].strip().rstrip("/")
            username = fields[1]["value"].strip()
            password = fields[2]["value"]
            if not url or not username or not password:
                error = "All fields are required."
                continue
            curses.curs_set(0)
            return {"url": url, "username": username, "password": password}

        elif ch in (curses.KEY_BACKSPACE, 127, 8):
            if fields[active]["value"]:
                fields[active]["value"] = fields[active]["value"][:-1]
            error = ""

        elif 32 <= ch < 127:
            if len(fields[active]["value"]) < 200:
                fields[active]["value"] += chr(ch)
            error = ""
