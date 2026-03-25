"""Overlay screens: Debug log viewer (F2) and Console/action log (always-on panel)."""

from __future__ import annotations
import curses
import os
from pathlib import Path

from cb.tui.colors import PAIR_NORMAL, PAIR_TITLE, PAIR_DIM, PAIR_ERROR, PAIR_SUCCESS, PAIR_WARNING
from cb.tui.widgets.widgets import safe_addstr

_LOG_FILE = Path("/tmp/bee.log")
_OVERLAY_MARGIN_X = 4
_OVERLAY_MARGIN_Y = 2


def _draw_overlay_box(win, title: str, lines: list[str], scroll: int) -> None:
    """Draw a bordered overlay with scrollable content inside win. ASCII-only."""
    rows, cols = win.getmaxyx()
    h  = rows - _OVERLAY_MARGIN_Y * 2
    w  = cols - _OVERLAY_MARGIN_X * 2
    y0 = _OVERLAY_MARGIN_Y
    x0 = _OVERLAY_MARGIN_X

    # Background fill
    for r in range(h):
        safe_addstr(win, y0 + r, x0, " " * w, curses.color_pair(PAIR_NORMAL))

    # Border (ASCII)
    border_attr = curses.color_pair(PAIR_TITLE) | curses.A_BOLD
    top    = "+" + "-" * (w - 2) + "+"
    mid    = "|" + " " * (w - 2) + "|"
    bottom = "+" + "-" * (w - 2) + "+"

    safe_addstr(win, y0,         x0, top,    border_attr)
    for r in range(1, h - 1):
        safe_addstr(win, y0 + r, x0, mid,    border_attr)
    safe_addstr(win, y0 + h - 1, x0, bottom, border_attr)

    # Title
    title_str = f"  {title}  "
    safe_addstr(win, y0, x0 + 2, title_str, curses.color_pair(PAIR_TITLE) | curses.A_BOLD)

    # Close hint
    hint = "  Esc / same key to close  "
    safe_addstr(win, y0 + h - 1, x0 + 2, hint, curses.color_pair(PAIR_DIM))

    content_h = h - 2
    content_w = w - 4
    
    import textwrap
    wrapped_items = []
    for line in lines:
        if "ERROR" in line or "CRITICAL" in line:
            attr = curses.color_pair(PAIR_ERROR)
        elif "WARNING" in line:
            attr = curses.color_pair(PAIR_WARNING)
        elif "INFO" in line or "OK" in line:
            attr = curses.color_pair(PAIR_SUCCESS)
        else:
            attr = curses.color_pair(PAIR_DIM)
            
        if not line:
            wrapped_items.append(("", attr))
        else:
            # Drop_whitespace=False to preserve indentations, though textwrap defaults are usually fine
            subs = textwrap.wrap(line, width=max(10, content_w))
            if not subs:
                wrapped_items.append(("", attr))
            for sub in subs:
                wrapped_items.append((sub, attr))

    visible = wrapped_items[scroll: scroll + content_h]

    for i, (text, attr) in enumerate(visible):
        safe_addstr(win, y0 + 1 + i, x0 + 2, text, attr)

    # Scroll indicator
    total = len(wrapped_items)
    scroll = max(0, min(scroll, total - content_h))
    if total > content_h:
        pct       = int(scroll / max(1, total - content_h) * 100)
        indicator = f" {scroll + 1}-{min(scroll + content_h, total)}/{total} ({pct}%) "
        safe_addstr(win, y0 + h - 1, x0 + w - len(indicator) - 2,
                    indicator, curses.color_pair(PAIR_DIM))
    return scroll



# -- Debug overlay (F2) -------------------------------------------------------


class DebugOverlay:
    """Live tail of /tmp/bee.log."""

    def __init__(self):
        self.scroll  = 999999
        self._lines: list[str] = []

    def _load(self) -> None:
        try:
            text = _LOG_FILE.read_text(errors="replace") if _LOG_FILE.exists() else ""
            self._lines = text.splitlines() or ["(log is empty)"]
        except OSError as e:
            self._lines = [f"Cannot read log: {e}"]

    def draw(self, win) -> None:
        self._load()
        self.scroll = _draw_overlay_box(win, "[DEBUG] /tmp/bee.log", self._lines, self.scroll)

    def handle_key(self, ch: int) -> bool:
        """Return True to keep overlay open, False to close."""
        if ch in (curses.KEY_F2, 27):   # F2 or Esc - close
            return False
        rows_visible = 20
        if ch in (curses.KEY_UP, ord('k')):
            self.scroll = max(0, self.scroll - 1)
        elif ch in (curses.KEY_DOWN, ord('j')):
            self.scroll += 1
        elif ch == curses.KEY_PPAGE:
            self.scroll = max(0, self.scroll - rows_visible)
        elif ch == curses.KEY_NPAGE:
            self.scroll += rows_visible
        elif ch in (ord('G'),):
            self.scroll = 999999
        elif ch in (ord('g'),):
            self.scroll = 0
        return True


# -- Console overlay (always-on bottom panel) ---------------------------------


class ConsoleOverlay:
    """CLI command log - shows the bee CLI equivalent of each TUI action."""

    def __init__(self):
        self.scroll  = 0
        self.entries: list[tuple[str, str, str]] = []

    def log_cmd(self, command: str, result: str = "") -> None:
        """Append a bee CLI command with an optional result line."""
        import time
        ts = time.strftime("%H:%M:%S")
        self.entries.append((ts, command, result))
        self.scroll = max(0, self._line_count() - 18)

    def _render_lines(self) -> list[tuple[str, str]]:
        """Expand entries into (text, kind) pairs ready for drawing.

        kind values: 'ts+cmd' | 'result' | 'blank' | 'empty'
        """
        if not self.entries:
            return [("  (no commands yet - perform actions to populate)", "empty")]

        lines: list[tuple[str, str]] = []
        for ts, cmd, result in self.entries:
            lines.append((f"  {ts}  $  {cmd}", "ts+cmd"))
            if result:
                lines.append((f"              OK  {result}", "result"))
            lines.append(("", "blank"))
        return lines

    def _line_count(self) -> int:
        return len(self._render_lines())

    def draw(self, win) -> None:
        """Draw as a scrollable modal (legacy - kept for compatibility)."""
        rows, cols = win.getmaxyx()
        h  = rows - _OVERLAY_MARGIN_Y * 2
        w  = cols - _OVERLAY_MARGIN_X * 2
        y0 = _OVERLAY_MARGIN_Y
        x0 = _OVERLAY_MARGIN_X

        border_attr = curses.color_pair(PAIR_TITLE) | curses.A_BOLD
        top    = "+" + "-" * (w - 2) + "+"
        mid    = "|" + " " * (w - 2) + "|"
        bottom = "+" + "-" * (w - 2) + "+"

        for r in range(h):
            safe_addstr(win, y0 + r, x0, " " * w, curses.color_pair(PAIR_NORMAL))
        safe_addstr(win, y0,         x0, top,    border_attr)
        for r in range(1, h - 1):
            safe_addstr(win, y0 + r, x0, mid, border_attr)
        safe_addstr(win, y0 + h - 1, x0, bottom, border_attr)

        safe_addstr(win, y0,         x0 + 2, "  [CLI Command Log]  ",
                    curses.color_pair(PAIR_TITLE) | curses.A_BOLD)
        safe_addstr(win, y0 + h - 1, x0 + 2, "  Esc to close  ",
                    curses.color_pair(PAIR_DIM))

        content_h = h - 2
        content_w = w - 4
        all_lines = self._render_lines()
        visible   = all_lines[self.scroll: self.scroll + content_h]

        for i, (text, kind) in enumerate(visible):
            row = y0 + 1 + i
            if kind == "ts+cmd" and "  $  " in text:
                ts_part, cmd_part = text.split("  $  ", 1)
                col = x0 + 2
                safe_addstr(win, row, col, ts_part, curses.color_pair(PAIR_DIM))
                col += len(ts_part)
                safe_addstr(win, row, col, "  $  ",
                            curses.color_pair(PAIR_SUCCESS) | curses.A_BOLD)
                col += 5
                safe_addstr(win, row, col,
                            cmd_part[: content_w - (col - x0 - 2)],
                            curses.color_pair(PAIR_NORMAL) | curses.A_BOLD)
            elif kind in ("result", "empty"):
                safe_addstr(win, row, x0 + 2, text[:content_w],
                            curses.color_pair(PAIR_DIM))

        total = len(all_lines)
        if total > content_h:
            pct       = int(self.scroll / max(1, total - content_h) * 100)
            indicator = f" {self.scroll + 1}-{min(self.scroll + content_h, total)}/{total} ({pct}%) "
            safe_addstr(win, y0 + h - 1, x0 + w - len(indicator) - 2,
                        indicator, curses.color_pair(PAIR_DIM))

    def handle_key(self, ch: int) -> bool:
        """Return True to keep overlay open, False to close."""
        if ch in (curses.KEY_F3, 27):
            return False
        content_h = 18
        total     = self._line_count()
        if ch == curses.KEY_UP:
            self.scroll = max(0, self.scroll - 1)
        elif ch == curses.KEY_DOWN:
            self.scroll = min(max(0, total - content_h), self.scroll + 1)
        elif ch == curses.KEY_PPAGE:
            self.scroll = max(0, self.scroll - content_h)
        elif ch == curses.KEY_NPAGE:
            self.scroll = min(max(0, total - content_h), self.scroll + content_h)
        return True

    def draw_panel(self, win) -> None:
        """Render as a compact bottom panel - one line per command (VS Code style).

        Each line:  HH:MM:SS  $  bee <command>   OK result
        Shows the most recent entries that fit in the window height.
        """
        rows, cols = win.getmaxyx()
        win.bkgd(" ", curses.color_pair(PAIR_NORMAL))
        win.erase()

        if not self.entries:
            safe_addstr(win, 0, 2,
                "  (no commands yet - perform an action to populate)",
                curses.color_pair(PAIR_DIM))
            return

        panel_lines: list[tuple[str, str, str]] = list(self.entries)
        visible = panel_lines[max(0, len(panel_lines) - rows):]

        for i, (ts, cmd, result) in enumerate(visible):
            if i >= rows:
                break
            col = 2
            safe_addstr(win, i, col, ts, curses.color_pair(PAIR_DIM))
            col += len(ts)
            safe_addstr(win, i, col, "  $  ",
                        curses.color_pair(PAIR_SUCCESS) | curses.A_BOLD)
            col += 5
            cmd_max = cols - col - (len(result) + 6 if result else 0) - 2
            safe_addstr(win, i, col, cmd[:max(0, cmd_max)],
                        curses.color_pair(PAIR_NORMAL) | curses.A_BOLD)
            if result:
                result_str = f"   OK {result}"
                safe_addstr(win, i, cols - len(result_str) - 1,
                            result_str[:cols - 2], curses.color_pair(PAIR_DIM))
