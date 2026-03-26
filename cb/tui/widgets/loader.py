"""Shared reusable widgets for bee TUI."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.reactive import reactive
from textual.widgets import Static


_FRAMES = ["[ |  ]", "[ /  ]", "[ -- ]", "[ \\  ]"]


class AsciiLoader(Static):
    """ASCII-only loading animation. Replaces Textual's LoadingIndicator
    which uses Unicode braille spinners incompatible with LANG=C terminals.

    Usage:
        yield AsciiLoader(id="loader")

    Show/hide:
        self.query_one(AsciiLoader).display = True / False
    """

    _frame: reactive[int] = reactive(0)

    def on_mount(self) -> None:
        self._update_text()
        self.set_interval(0.25, self._tick)

    def _tick(self) -> None:
        self._frame = (self._frame + 1) % len(_FRAMES)
        self._update_text()

    def watch__frame(self, _: int) -> None:
        self._update_text()

    def _update_text(self) -> None:
        self.update(_FRAMES[self._frame] + " loading...")
