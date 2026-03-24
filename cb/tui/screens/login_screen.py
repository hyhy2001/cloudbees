"""Login screen — collects URL, username, password."""

from __future__ import annotations
import curses

from cb.tui.colors import (
    PAIR_TITLE, PAIR_ERROR, PAIR_SUCCESS, PAIR_HEADER,
    PAIR_NORMAL, PAIR_DIM, PAIR_INPUT, PAIR_SELECTED,
)
from cb.tui.widgets.widgets import safe_addstr
from cb.tui.keys import KEY_ENTER, KEY_ESC

_FORM_W = 52   # inner width of the form box


def _fill_bg(win, attr: int) -> None:
    """Fill entire window with background color."""
    rows, cols = win.getmaxyx()
    blank = " " * (cols - 1)
    for r in range(rows):
        try:
            win.addstr(r, 0, blank, attr)
        except curses.error:
            pass


def _box_line(content: str) -> str:
    return f"| {content:<{_FORM_W}} |"


def _draw_login_form(stdscr, fields, active, error):
    rows, cols = stdscr.getmaxyx()

    # Full-screen background
    _fill_bg(stdscr, curses.color_pair(PAIR_NORMAL))

    # Center the dialog box
    box_h  = 20
    box_w  = _FORM_W + 4          # 2 for "| " + " |"
    cy = max(0, rows // 2 - box_h // 2)
    cx = max(0, cols // 2 - box_w // 2)

    border_attr  = curses.color_pair(PAIR_HEADER) | curses.A_BOLD
    label_attr   = curses.color_pair(PAIR_DIM)
    hint_attr    = curses.color_pair(PAIR_TITLE)

    sep  = "+" + "-" * (box_w - 2) + "+"
    pad  = _box_line("")

    # ── Box top ──
    y = cy
    safe_addstr(stdscr, y, cx, sep, border_attr); y += 1

    # Title row
    title = " bee - CloudBees Login "
    title_padded = title.center(_FORM_W)
    safe_addstr(stdscr, y, cx, f"|{title_padded}|",
                curses.color_pair(PAIR_HEADER) | curses.A_BOLD); y += 1
    safe_addstr(stdscr, y, cx, sep, border_attr); y += 1
    safe_addstr(stdscr, y, cx, pad, border_attr); y += 1

    # ── Fields ──
    for i, field in enumerate(fields):
        is_active = (i == active)
        field_attr = curses.color_pair(PAIR_INPUT) | (curses.A_BOLD if is_active else 0)
        box_attr   = curses.color_pair(PAIR_SELECTED) if is_active else border_attr
        marker     = ">" if is_active else " "

        # Label
        label = f"{marker} {field['label']}:"
        safe_addstr(stdscr, y, cx, _box_line(label), label_attr); y += 1

        # Input border top
        field_border = "+" + "-" * (_FORM_W) + "+"
        safe_addstr(stdscr, y, cx + 2, field_border, box_attr); y += 1

        # Input value
        display = "*" * len(field["value"]) if field["secret"] else field["value"]
        display = display[-(_FORM_W - 2):] if len(display) > _FORM_W - 2 else display
        input_line = f"| {display:<{_FORM_W - 2}} |"
        safe_addstr(stdscr, y, cx + 2, input_line, field_attr); y += 1

        # Input border bottom
        safe_addstr(stdscr, y, cx + 2, field_border, box_attr); y += 1

        # Spacer
        safe_addstr(stdscr, y, cx, pad, border_attr); y += 1

    # ── Error / hint ──
    if error:
        err_line = f"  [!] {error:<{_FORM_W - 5}}"
        safe_addstr(stdscr, y, cx, _box_line(err_line),
                    curses.color_pair(PAIR_ERROR) | curses.A_BOLD); y += 1
    else:
        safe_addstr(stdscr, y, cx, pad, border_attr); y += 1

    hints = "Tab/Down=Next   Up=Prev   Enter=Login   Esc=Cancel"
    safe_addstr(stdscr, y, cx, _box_line(f"  {hints}"), hint_attr); y += 1
    safe_addstr(stdscr, y, cx, sep, border_attr)

    # ── Move cursor to active field value ──
    field_start_y = cy + 4                    # first field's label row
    cursor_y = field_start_y + active * 5 + 1 # value row
    cursor_x = cx + 4 + len(
        "*" * len(fields[active]["value"]) if fields[active]["secret"]
        else fields[active]["value"]
    )
    try:
        stdscr.move(cursor_y, min(cursor_x, cols - 2))
    except curses.error:
        pass


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
        _draw_login_form(stdscr, fields, active, error)
        stdscr.refresh()

        ch = stdscr.getch()

        if ch in KEY_ESC:
            curses.curs_set(0)
            return None

        if ch in (curses.KEY_DOWN, ord("\t")):
            active = (active + 1) % len(fields)
            error  = ""
            continue

        if ch == curses.KEY_UP:
            active = (active - 1) % len(fields)
            error  = ""
            continue

        if ch in KEY_ENTER:
            url      = fields[0]["value"].strip().rstrip("/")
            username = fields[1]["value"].strip()
            password = fields[2]["value"]
            if not url or not username or not password:
                error = "All fields are required."
                continue
            curses.curs_set(0)
            return {"url": url, "username": username, "password": password}

        if ch in (curses.KEY_BACKSPACE, 127, 8):
            if fields[active]["value"]:
                fields[active]["value"] = fields[active]["value"][:-1]
            error = ""
        elif 32 <= ch < 127:
            if len(fields[active]["value"]) < 200:
                fields[active]["value"] += chr(ch)
            error = ""
