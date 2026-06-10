"""Terminal compatibility helpers.

Symbol strategy:
- DEFAULT: Unicode symbols (works on modern terminals / UTF-8 locales).
- Set BEE_ASCII=1 to fall back to pure ASCII for legacy terminals.

Border strategy:
- Textual CSS: `border: ascii` for ASCII mode, `border: round` for Unicode.
"""
from __future__ import annotations

import os
import sys


def _is_ascii_forced() -> bool:
    """Return True when user explicitly opts OUT of Unicode via BEE_ASCII=1."""
    return os.environ.get("BEE_ASCII", "").lower() in ("1", "true", "yes")


def _has_utf8() -> bool:
    """Detect if the terminal can render UTF-8."""
    enc = (sys.stdout.encoding or "").upper()
    lang = (
        os.environ.get("LC_ALL")
        or os.environ.get("LANG")
        or ""
    ).upper()
    return "UTF" in enc or "UTF" in lang


# Unicode is ON by default on UTF-8 terminals; opt-out via BEE_ASCII=1
_UNICODE = _has_utf8() and not _is_ascii_forced()


class _Symbols:
    """Terminal-safe symbol set. Unicode by default, ASCII fallback."""

    def __init__(self, unicode_mode: bool) -> None:
        if unicode_mode:
            # Rich Unicode symbols for modern terminals
            self.ok       = "✓"
            self.fail     = "✗"
            self.warn     = "⚠"
            self.aborted  = "◇"
            self.notbuilt = "○"
            self.disabled = "⊘"
            self.running  = "●"
            self.gear     = "⚙"
            self.warn_tri = "▲"
            self.bee      = "🐝"
            self.sep      = "─"
            self.pipe     = "│"
            self.arrow    = "›"
            self.dot      = "·"
            self.online   = "◉"
            self.offline  = "◌"
            self.selected = "▶"
            self.spinner_frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        else:
            # Pure ASCII fallback (7-bit safe)
            self.ok       = "[OK]"
            self.fail     = "[!!]"
            self.warn     = "[~~]"
            self.aborted  = "[--]"
            self.notbuilt = "[  ]"
            self.disabled = "[DI]"
            self.running  = "[>>]"
            self.gear     = "[**]"
            self.warn_tri = "[/!]"
            self.bee      = "bee"
            self.sep      = "-"
            self.pipe     = "|"
            self.arrow    = ">"
            self.dot      = "."
            self.online   = "[O]"
            self.offline  = "[ ]"
            self.selected = ">"
            self.spinner_frames = ["[ |  ]", "[ /  ]", "[ -- ]", "[ \\  ]"]


SYM = _Symbols(_UNICODE)
UNICODE_MODE = _UNICODE


def get_border_style() -> str:
    """Return Textual border style token."""
    return "round" if _UNICODE else "ascii"
