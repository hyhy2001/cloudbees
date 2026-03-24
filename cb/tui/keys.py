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

# Screen shortcuts: 1=Dashboard, 2=Controller, 3=Credentials, 4=Nodes, 5=Jobs, 6=Users, 7=System
SCREEN_KEYS = {
    ord('1'): 0,
    ord('2'): 1,
    ord('3'): 2,
    ord('4'): 3,
    ord('5'): 4,
    ord('6'): 5,
    ord('7'): 6,
}
SCREEN_COUNT = 7

# Actions
KEY_RUN     = ord('r')
KEY_STOP    = ord('s')
KEY_CREATE  = ord('c')
KEY_DELETE  = ord('d')
KEY_SEARCH  = ord('/')
KEY_REFRESH = curses.KEY_F5
KEY_CACHE   = ord('C')
KEY_LOGIN   = ord('L')
KEY_LOGOUT  = ord('X')
KEY_TAB     = ord('\t')
KEY_HELP    = ord('?')

# Status bar hints
HINTS = "q:Quit  Tab/Arrow:Navigate  1-7:Screen  Enter:Select  L:Login  X:Logout  F5:Refresh"
