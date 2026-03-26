"""Terminal compatibility helpers.

Detects whether the current terminal supports Unicode (UTF-8) and
truecolor/256-color. Provides a safe symbol set so the TUI degrades
gracefully on ASCII-only / limited terminals.

Usage:
    from cb.tui.compat import SYM, supports_unicode

    print(SYM.ok)        →  "●" (UTF-8) or "[OK]" (ASCII)
    print(SYM.running)   →  "▶" (UTF-8) or  ">" (ASCII)
"""
from __future__ import annotations

import locale
import os
import sys


def supports_unicode() -> bool:
    """Return True if the terminal/locale is UTF-8 capable.

    Detection order (first match wins):
    1. BEE_ASCII_ONLY=1  → always False (forced ASCII)
    2. LANG / LC_ALL / LC_CTYPE env vars → check for "UTF"
    3. sys.stdout.encoding                → check for "UTF"

    LANG=C and LANG=POSIX are treated as ASCII-only.
    """
    # 1. Explicit opt-out
    if os.environ.get("BEE_ASCII_ONLY", "").lower() in ("1", "true", "yes"):
        return False

    # 2. Check POSIX locale env vars — most reliable on Linux corporate boxes
    for var in ("LC_ALL", "LC_CTYPE", "LANG"):
        val = os.environ.get(var, "").upper()
        if not val:
            continue
        # "C", "POSIX", "C.ASCII" → ASCII only
        if val in ("C", "POSIX") or val.startswith("C.") or val.startswith("POSIX."):
            return False
        # "en_US.UTF-8", "UTF-8", "C.UTF-8" → has Unicode
        if "UTF" in val:
            return True

    # 3. Fallback: Python's detected stdout encoding
    enc = (sys.stdout.encoding or "").upper()
    return "UTF" in enc


_UNICODE = supports_unicode()


class _Symbols:
    """Terminal-safe symbol set. Falls back to ASCII equivalents."""

    def __init__(self, unicode_mode: bool) -> None:
        if unicode_mode:
            self.ok       = "●"
            self.fail     = "●"
            self.warn     = "●"
            self.aborted  = "●"
            self.notbuilt = "○"
            self.disabled = "⊘"
            self.running  = "▶"
            self.gear     = "⚙"
            self.warn_tri = "⚠"
            self.bee      = "🐝"
            self.bullet   = "·"
        else:
            # Pure ASCII replacements
            self.ok       = "[*]"
            self.fail     = "[X]"
            self.warn     = "[!]"
            self.aborted  = "[-]"
            self.notbuilt = "[ ]"
            self.disabled = "[D]"
            self.running  = ">"
            self.gear     = "[S]"
            self.warn_tri = "[!]"
            self.bee      = "[bee]"
            self.bullet   = "-"


SYM = _Symbols(_UNICODE)


def get_border_style() -> str:
    """Return Textual border style appropriate for the terminal."""
    # 'round' uses box-drawing characters (Unicode); 'ascii' uses + - |
    return "round" if _UNICODE else "ascii"
