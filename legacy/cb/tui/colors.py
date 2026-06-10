"""256-color palette for the TUI. Falls back to 8-color if unavailable."""
from __future__ import annotations

import curses

# Color pair IDs
PAIR_NORMAL     = 1
PAIR_HEADER     = 2
PAIR_SIDEBAR    = 3
PAIR_SELECTED   = 4
PAIR_STATUS     = 5
PAIR_SUCCESS    = 6
PAIR_ERROR      = 7
PAIR_WARNING    = 8
PAIR_DIM        = 9
PAIR_ACTIVE     = 10
PAIR_INPUT      = 11
PAIR_KEYHINT    = 12
PAIR_TITLE      = 13


def init_colors() -> bool:
    """Initialise color pairs. Returns True if 256-color is available."""
    curses.start_color()
    curses.use_default_colors()

    if curses.COLORS >= 256:
        # 256-color palette
        curses.init_pair(PAIR_NORMAL,   252, 234)   # #d0d0d0 on #1c1c1c
        curses.init_pair(PAIR_HEADER,   255, 24)    # white on deep blue
        curses.init_pair(PAIR_SIDEBAR,  244, 236)   # dim on dark grey
        curses.init_pair(PAIR_SELECTED, 255, 31)    # white on teal
        curses.init_pair(PAIR_STATUS,   244, 238)   # dim on dark
        curses.init_pair(PAIR_SUCCESS,  82,  234)   # green on base
        curses.init_pair(PAIR_ERROR,    196, 234)   # red on base
        curses.init_pair(PAIR_WARNING,  220, 234)   # yellow on base
        curses.init_pair(PAIR_DIM,      244, 234)   # dimmed
        curses.init_pair(PAIR_ACTIVE,   214, 236)   # amber on sidebar
        curses.init_pair(PAIR_INPUT,    252, 237)   # text on input bg
        curses.init_pair(PAIR_KEYHINT,  39,  238)   # cyan on statusbar
        curses.init_pair(PAIR_TITLE,    255, 234)   # title text
        return True
    else:
        # 8-color fallback
        curses.init_pair(PAIR_NORMAL,   curses.COLOR_WHITE,   curses.COLOR_BLACK)
        curses.init_pair(PAIR_HEADER,   curses.COLOR_WHITE,   curses.COLOR_BLUE)
        curses.init_pair(PAIR_SIDEBAR,  curses.COLOR_WHITE,   curses.COLOR_BLACK)
        curses.init_pair(PAIR_SELECTED, curses.COLOR_BLACK,   curses.COLOR_CYAN)
        curses.init_pair(PAIR_STATUS,   curses.COLOR_WHITE,   curses.COLOR_BLACK)
        curses.init_pair(PAIR_SUCCESS,  curses.COLOR_GREEN,   curses.COLOR_BLACK)
        curses.init_pair(PAIR_ERROR,    curses.COLOR_RED,     curses.COLOR_BLACK)
        curses.init_pair(PAIR_WARNING,  curses.COLOR_YELLOW,  curses.COLOR_BLACK)
        curses.init_pair(PAIR_DIM,      curses.COLOR_WHITE,   curses.COLOR_BLACK)
        curses.init_pair(PAIR_ACTIVE,   curses.COLOR_YELLOW,  curses.COLOR_BLACK)
        curses.init_pair(PAIR_INPUT,    curses.COLOR_WHITE,   curses.COLOR_BLACK)
        curses.init_pair(PAIR_KEYHINT,  curses.COLOR_CYAN,    curses.COLOR_BLACK)
        curses.init_pair(PAIR_TITLE,    curses.COLOR_WHITE,   curses.COLOR_BLACK)
        return False
