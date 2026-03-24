from __future__ import annotations
"""Keyboard constants."""

import curses

# Navigation
KEY_UP    = [curses.KEY_UP,    ord('k')]
KEY_DOWN  = [curses.KEY_DOWN,  ord('j')]
KEY_LEFT  = [curses.KEY_LEFT,  ord('h')]
KEY_RIGHT = [curses.KEY_RIGHT, ord('l')]
KEY_ENTER = [curses.KEY_ENTER, ord('\n'), ord('\r')]
KEY_ESC   = [27]
KEY_QUIT  = [ord('q'), ord('Q')]

# Screen shortcuts
SCREEN_KEYS = {
    ord('1'): 0,  # Dashboard
    ord('2'): 1,  # Jobs
    ord('3'): 2,  # Pipelines
    ord('4'): 3,  # Users
    ord('5'): 4,  # System
}

# Actions
KEY_RUN     = ord('r')
KEY_STOP    = ord('s')
KEY_DETAIL  = ord('d')
KEY_SEARCH  = ord('/')
KEY_REFRESH = curses.KEY_F5
KEY_CACHE   = ord('C')
KEY_LOGIN   = ord('l')
KEY_LOGOUT  = ord('L')
KEY_PROFILE = ord('p')
KEY_TAB     = ord('\t')
KEY_HELP    = ord('?')

# Status bar hints
HINTS = "q:Quit  Tab:Menu  1-5:Screen  r:Run  d:Detail  F5:Refresh  C:ClearCache  ?:Help"
