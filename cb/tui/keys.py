"""Keyboard constants."""

from __future__ import annotations
import curses

# Navigation
KEY_UP    = [curses.KEY_UP,    ord('k')]
KEY_DOWN  = [curses.KEY_DOWN,  ord('j')]
KEY_LEFT  = [curses.KEY_LEFT,  ord('h')]
KEY_RIGHT = [curses.KEY_RIGHT, ord('l')]
KEY_ENTER = [curses.KEY_ENTER, ord('\n'), ord('\r')]
KEY_ESC   = [27]
KEY_QUIT  = [ord('q'), ord('Q')]

# Screen shortcuts: 1=Controller, 2=Credentials, 3=Nodes, 4=Jobs, 5=Settings
SCREEN_KEYS = {
    ord('1'): 0,  # Controller
    ord('2'): 1,  # Credentials
    ord('3'): 2,  # Nodes
    ord('4'): 3,  # Jobs
    ord('5'): 4,  # Settings
}
SCREEN_COUNT = 5

# Actions
KEY_RUN     = ord('r')
KEY_STOP    = ord('s')
KEY_CREATE  = ord('c')
KEY_DELETE  = ord('d')
KEY_SEARCH  = ord('/')
KEY_REFRESH = curses.KEY_F5
KEY_DEBUG   = curses.KEY_F2   # overlay: tail /tmp/bee.log
KEY_CONSOLE = curses.KEY_F3   # overlay: in-session action log
KEY_CACHE   = ord('C')
KEY_LOGIN   = ord('L')
KEY_LOGOUT  = ord('X')
KEY_TAB     = ord('\t')
KEY_HELP    = ord('?')

# Context-aware status bar hints
HINTS_SIDEBAR = "q:Quit  ↑↓:Move  Enter/→:Open  1-5:Jump  L:Login  X:Logout  F2:Debug  F3:Console  F5:Refresh"
HINTS_CONTENT = "↑↓:Scroll  ←/Esc:Back  r:Run  j/k:Move  q:Quit  F2:Debug  F3:Console  F5:Refresh"
