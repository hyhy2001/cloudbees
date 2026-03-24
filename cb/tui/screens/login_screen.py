"""Login screen — collects URL, username, password."""

from __future__ import annotations
import curses

from cb.tui.colors import PAIR_TITLE, PAIR_ERROR, PAIR_SUCCESS, PAIR_HEADER
from cb.tui.widgets.widgets import safe_addstr, draw_input_box
from cb.tui.keys import KEY_ENTER, KEY_ESC


def show_login(stdscr, existing_url: str = "") -> dict | None:
    """
    Interactive login form.
    Returns {"url": ..., "username": ..., "password": ...} or None if cancelled.
    """
    curses.curs_set(1)
    fields = [
        {"label": "Server URL",  "value": existing_url, "secret": False},
        {"label": "Username",    "value": "",            "secret": False},
        {"label": "Password",    "value": "",            "secret": True},
    ]
    active = 0
    error = ""

    while True:
        stdscr.erase()
        rows, cols = stdscr.getmaxyx()
        cx = max(0, cols // 2 - 25)
        cy = max(0, rows // 2 - 8)

        # Title
        safe_addstr(stdscr, cy, cx, "+----------- Login to CloudBees -----------+",
                    curses.color_pair(PAIR_HEADER) | curses.A_BOLD)
        safe_addstr(stdscr, cy + 1, cx, "|                                          |",
                    curses.color_pair(PAIR_HEADER))

        for i, field in enumerate(fields):
            draw_input_box(
                stdscr,
                y=cy + 2 + i * 5, x=cx,
                label=field["label"], value=field["value"],
                width=38, secret=field["secret"], active=(i == active),
            )

        if error:
            safe_addstr(stdscr, cy + 17, cx, f"  [!] {error}", curses.color_pair(PAIR_ERROR))

        safe_addstr(stdscr, cy + 19, cx,
                    "  Tab/Down=Next  Enter=Login  Esc=Cancel",
                    curses.color_pair(PAIR_TITLE))

        # Place cursor in active field
        cursor_row = cy + 2 + active * 5 + 2
        cursor_col = cx + 2 + len(fields[active]["value"])
        try:
            stdscr.move(cursor_row, cursor_col)
        except curses.error:
            pass

        stdscr.refresh()
        ch = stdscr.getch()

        if ch in KEY_ESC:
            curses.curs_set(0)
            return None

        if ch in [curses.KEY_DOWN, ord('\t')]:
            active = (active + 1) % len(fields)
            continue

        if ch == curses.KEY_UP:
            active = (active - 1) % len(fields)
            continue

        if ch in KEY_ENTER:
            url = fields[0]["value"].strip().rstrip("/")
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
        elif 32 <= ch < 127:
            if len(fields[active]["value"]) < 100:
                fields[active]["value"] += chr(ch)
