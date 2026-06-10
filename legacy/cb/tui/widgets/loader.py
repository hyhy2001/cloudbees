"""Shared reusable widgets for bee TUI."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.reactive import reactive
from textual.widgets import Static

from cb.tui.compat import SYM


class AsciiLoader(Static):
    """Terminal-safe loading spinner.

    Uses Unicode braille spinners when available (via SYM), falls back
    to ASCII bracket animation for LANG=C terminals.
    """

    _frame: reactive[int] = reactive(0)

    def on_mount(self) -> None:
        self._update_text()
        self.set_interval(0.10, self._tick)

    def _tick(self) -> None:
        frames = SYM.spinner_frames
        self._frame = (self._frame + 1) % len(frames)
        self._update_text()

    def watch__frame(self, _: int) -> None:
        self._update_text()

    def _update_text(self) -> None:
        frame = SYM.spinner_frames[self._frame % len(SYM.spinner_frames)]
        self.update(f"[bold blue]{frame}[/bold blue] [dim]Loading...[/dim]")
