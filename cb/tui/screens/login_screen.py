"""Login screen — collects URL, username, password."""

from __future__ import annotations
import curses

from cb.tui.colors import (
    PAIR_TITLE, PAIR_ERROR, PAIR_HEADER,
    PAIR_NORMAL, PAIR_DIM, PAIR_INPUT,
)
from cb.tui.widgets.widgets import safe_addstr
from cb.tui.keys import KEY_ENTER, KEY_ESC

# ── Layout constants ──────────────────────────────────────────────────────────
BOX_W   = 58          # total box width  (includes the two | walls)
PAD     = 2           # spaces between outer wall and content
ROW_W   = BOX_W - 2 - 2 * PAD   # text width inside a _row()  => 52
FIELD_W = BOX_W - 2 * PAD - 4   # inner input field width     => 50


def _sep() -> str:
    return "+" + "-" * (BOX_W - 2) + "+"


def _row(text: str = "") -> str:
    """Outer box content row, padded to BOX_W chars."""
    return "|" + " " * PAD + f"{text:<{ROW_W}}" + " " * PAD + "|"


def _field_sep() -> str:
    return "|" + " " * PAD + "+" + "-" * FIELD_W + "+" + " " * PAD + "|"


def _field_val(text: str) -> str:
    return "|" + " " * PAD + "|" + f"{text:<{FIELD_W}}" + "|" + " " * PAD + "|"


def _fill_bg(stdscr) -> None:
    rows, cols = stdscr.getmaxyx()
    blank = " " * (cols - 1)
    attr  = curses.color_pair(PAIR_NORMAL)
    for r in range(rows):
        try:
            stdscr.addstr(r, 0, blank, attr)
        except curses.error:
            pass


def _draw_form(stdscr, fields: list, active: int, error: str) -> list[int]:
    """Draw the login box. Returns list of value-row y positions for each field."""
    rows, cols = stdscr.getmaxyx()
    cx = max(0, cols // 2 - BOX_W // 2)

    # total rows: sep + title + sep + blank + (label+sep+val+sep+blank)*3 + err + hint + sep
    box_h = 3 + 1 + len(fields) * 5 + 2 + 1
    cy = max(0, rows // 2 - box_h // 2)

    _fill_bg(stdscr)

    ba = curses.color_pair(PAIR_HEADER) | curses.A_BOLD   # border
    da = curses.color_pair(PAIR_DIM)                       # dim rows
    ha = curses.color_pair(PAIR_TITLE)                     # hint
    ea = curses.color_pair(PAIR_ERROR)  | curses.A_BOLD   # error
    ia = curses.color_pair(PAIR_INPUT)                     # input value
    na = curses.color_pair(PAIR_NORMAL)                    # normal

    y = cy

    # Top border
    safe_addstr(stdscr, y, cx, _sep(), ba); y += 1

    # Title
    title = "bee - Login to CloudBees"
    safe_addstr(stdscr, y, cx, _row(title.center(ROW_W)), ba | curses.A_BOLD); y += 1
    safe_addstr(stdscr, y, cx, _sep(), ba); y += 1
    safe_addstr(stdscr, y, cx, _row(), da); y += 1

    # Fields
    val_rows = []
    for i, field in enumerate(fields):
        marker = ">" if i == active else " "
        safe_addstr(stdscr, y, cx,
                    _row(f"{marker} {field['label']}:"), da); y += 1
        safe_addstr(stdscr, y, cx, _field_sep(), na); y += 1

        display = "*" * len(field["value"]) if field["secret"] else field["value"]
        display = display[-FIELD_W:] if len(display) > FIELD_W else display
        val_rows.append(y)
        safe_addstr(stdscr, y, cx, _field_val(display), ia); y += 1

        safe_addstr(stdscr, y, cx, _field_sep(), na); y += 1
        safe_addstr(stdscr, y, cx, _row(), da); y += 1

    # Error / hint
    if error:
        safe_addstr(stdscr, y, cx, _row(f"[!] {error}"), ea)
    else:
        safe_addstr(stdscr, y, cx, _row(), da)
    y += 1

    safe_addstr(stdscr, y, cx,
        _row("Tab=Next  Up=Prev  Enter=Login  Esc=Cancel".center(ROW_W)), ha); y += 1
    safe_addstr(stdscr, y, cx, _sep(), ba)

    return val_rows


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
        val_rows = _draw_form(stdscr, fields, active, error)

        # ── Cursor ──
        rows, cols = stdscr.getmaxyx()
        cx = max(0, cols // 2 - BOX_W // 2)
        display = fields[active]["value"]
        if fields[active]["secret"]:
            display = "*" * len(display)
        cursor_x = cx + PAD + 1 + min(len(display), FIELD_W)  # inside |  |...|
        try:
            stdscr.move(val_rows[active], cursor_x)
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
