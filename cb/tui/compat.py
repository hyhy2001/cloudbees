"""Terminal compatibility helpers.

Symbol strategy:
- DEFAULT: ASCII symbols (| + - = [ ] > *) - works on any terminal.
- Set BEE_UNICODE=1 to enable Unicode symbols only on terminals that support them.

Border strategy:
- Textual CSS uses `border: ascii` in bee.tcss -> + - | chars only.

Usage:
    from cb.tui.compat import SYM
    print(SYM.ok)      ->  "[OK]"  (ASCII) or "O" (Unicode branch)
    print(SYM.running) ->  ">"     (ASCII, always)
"""
from __future__ import annotations

import os
import sys


def wants_unicode() -> bool:
    """Return True only when the user explicitly opts IN to Unicode mode.

    ASCII is the safe default. Unicode requires BEE_UNICODE=1.
    """
    if os.environ.get("BEE_UNICODE", "").lower() in ("1", "true", "yes"):
        active = (
            os.environ.get("LC_ALL")
            or os.environ.get("LANG")
            or ""
        ).upper()
        enc = (sys.stdout.encoding or "").upper()
        return "UTF" in active or "UTF" in enc
    return False


_UNICODE = wants_unicode()


class _Symbols:
    """Terminal-safe symbol set."""

    def __init__(self, unicode_mode: bool) -> None:
        # ASCII mode (default) -- pure 7-bit characters only
        self.ok       = "[OK]"
        self.fail     = "[!]"
        self.warn     = "[~]"
        self.aborted  = "[-]"
        self.notbuilt = "[ ]"
        self.disabled = "[D]"
        self.running  = ">"
        self.gear     = "[*]"
        self.warn_tri = "[!]"
        self.bee      = "bee"
        self.sep      = "-"
        self.pipe     = "|"

        if unicode_mode:
            # Override to Unicode only when BEE_UNICODE=1 AND UTF-8 locale
            self.ok       = "(OK)"
            self.fail     = "(X)"
            self.warn     = "(!)"
            self.aborted  = "(-)"
            self.notbuilt = "( )"
            self.disabled = "(D)"
            self.running  = ">>"
            self.gear     = "(*)"
            self.warn_tri = "(!)"
            self.bee      = "[bee]"
            self.sep      = "="
            self.pipe     = "|"


SYM = _Symbols(_UNICODE)


def get_border_style() -> str:
    """Return 'ascii' always (uses + - | chars)."""
    return "ascii"
