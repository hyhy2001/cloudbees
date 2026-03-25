"""Overlay screens: Debug log viewer (F2) and Console/action log (F3)."""

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
    """Draw a bordered overlay with scrollable content inside ``win``."""
    rows, cols = win.getmaxyx()
    h = rows - _OVERLAY_MARGIN_Y * 2
    w = cols - _OVERLAY_MARGIN_X * 2
    y0 = _OVERLAY_MARGIN_Y
    x0 = _OVERLAY_MARGIN_X

    # Background fill
    for r in range(h):
        safe_addstr(win, y0 + r, x0, " " * w, curses.color_pair(PAIR_NORMAL))

    # Border
    border_attr = curses.color_pair(PAIR_TITLE) | curses.A_BOLD
    top    = "╔" + "═" * (w - 2) + "╗"
    mid    = "║" + " " * (w - 2) + "║"
    bottom = "╚" + "═" * (w - 2) + "╝"

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

    # Content area
    content_h = h - 2       # inner rows (excluding top/bottom borders)
    content_w = w - 4       # inner cols (margin inside borders)
    visible = lines[scroll: scroll + content_h]

    for i, line in enumerate(visible):
        # Colour-code by log level keyword
        if "ERROR" in line or "CRITICAL" in line:
            attr = curses.color_pair(PAIR_ERROR)
        elif "WARNING" in line:
            attr = curses.color_pair(PAIR_WARNING)
        elif "INFO" in line or "✅" in line:
            attr = curses.color_pair(PAIR_SUCCESS)
        else:
            attr = curses.color_pair(PAIR_DIM)
        safe_addstr(win, y0 + 1 + i, x0 + 2, line[:content_w], attr)

    # Scroll indicator
    total = len(lines)
    if total > content_h:
        pct = int(scroll / max(1, total - content_h) * 100)
        indicator = f" {scroll + 1}-{min(scroll + content_h, total)}/{total} ({pct}%) "
        safe_addstr(win, y0 + h - 1, x0 + w - len(indicator) - 2,
                    indicator, curses.color_pair(PAIR_DIM))


# ── Debug overlay (F2) ────────────────────────────────────────────────────────


class DebugOverlay:
    """Live tail of /tmp/bee.log."""

    def __init__(self):
        self.scroll = 0
        self._lines: list[str] = []

    def _load(self) -> None:
        try:
            text = _LOG_FILE.read_text(errors="replace") if _LOG_FILE.exists() else ""
            self._lines = text.splitlines() or ["(log is empty)"]
        except OSError as e:
            self._lines = [f"Cannot read log: {e}"]
        # Auto-scroll to bottom on every load
        rows_visible = 20   # approximate; real clip done in draw
        self.scroll = max(0, len(self._lines) - rows_visible)

    def draw(self, win) -> None:
        self._load()
        _draw_overlay_box(win, "🐛 Debug Log  /tmp/bee.log", self._lines, self.scroll)

    def handle_key(self, ch: int) -> bool:
        """Return True to keep overlay open, False to close."""
        if ch in (curses.KEY_F2, 27):   # F2 or Esc → close
            return False
        rows_visible = 20
        if ch in (curses.KEY_UP, ord('k')):
            self.scroll = max(0, self.scroll - 1)
        elif ch in (curses.KEY_DOWN, ord('j')):
            self.scroll = min(max(0, len(self._lines) - rows_visible), self.scroll + 1)
        elif ch == curses.KEY_PPAGE:    # Page Up
            self.scroll = max(0, self.scroll - rows_visible)
        elif ch == curses.KEY_NPAGE:    # Page Down
            self.scroll = min(max(0, len(self._lines) - rows_visible), self.scroll + rows_visible)
        elif ch in (ord('G'),):         # go to bottom
            self.scroll = max(0, len(self._lines) - rows_visible)
        elif ch in (ord('g'),):         # go to top
            self.scroll = 0
        return True


# ── Console overlay (F3) ─────────────────────────────────────────────────────


class ConsoleOverlay:
    """In-session action log — records every user action during the TUI run."""

    def __init__(self):
        self.scroll = 0
        self.entries: list[str] = []    # populated by app.py via .log()

    def log(self, message: str) -> None:
        """Append a timestamped entry (called from app.py)."""
        import time
        ts = time.strftime("%H:%M:%S")
        self.entries.append(f"[{ts}] {message}")
        # Auto-scroll to newest
        self.scroll = max(0, len(self.entries) - 20)

    def draw(self, win) -> None:
        lines = self.entries if self.entries else ["(no actions yet — navigate around to populate)"]
        _draw_overlay_box(win, "📋 Console  — session action log", lines, self.scroll)

    def handle_key(self, ch: int) -> bool:
        """Return True to keep overlay open, False to close."""
        if ch in (curses.KEY_F3, 27):   # F3 or Esc → close
            return False
        rows_visible = 20
        if ch in (curses.KEY_UP, ord('k')):
            self.scroll = max(0, self.scroll - 1)
        elif ch in (curses.KEY_DOWN, ord('j')):
            self.scroll = min(max(0, len(self.entries) - rows_visible), self.scroll + 1)
        elif ch == curses.KEY_PPAGE:
            self.scroll = max(0, self.scroll - rows_visible)
        elif ch == curses.KEY_NPAGE:
            self.scroll = min(max(0, len(self.entries) - rows_visible), self.scroll + rows_visible)
        return True
