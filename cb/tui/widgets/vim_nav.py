"""Shared vim-nav mixin for panes with a DataTable.

Usage in a Widget subclass:
    from cb.tui.widgets.vim_nav import VimNavMixin

    class MyPane(VimNavMixin, Widget):
        ...

VimNavMixin provides:
  j / ↓   → cursor down
  k / ↑   → cursor up
  g       → jump to first row
  G       → jump to last row
  ctrl+f  → page down  (10 rows)
  ctrl+b  → page up    (10 rows)
"""
from __future__ import annotations

from textual.binding import Binding
from textual.widgets import DataTable


class VimNavMixin:
    """Add j/k/g/G/Ctrl+f/Ctrl+b vim navigation to a pane that contains a DataTable."""

    # These bindings are merged with the subclass BINDINGS list.
    # show=False keeps the Textual footer uncluttered.
    BINDINGS = [
        Binding("j",      "vim_down",      "",          show=False),
        Binding("k",      "vim_up",        "",          show=False),
        Binding("g",      "vim_top",       "",          show=False),
        Binding("G",      "vim_bottom",    "",          show=False),
        Binding("ctrl+f", "vim_page_down", "",          show=False),
        Binding("ctrl+b", "vim_page_up",   "",          show=False),
    ]

    def _table(self) -> DataTable:
        return self.query_one(DataTable)  # type: ignore[attr-defined]

    def action_vim_down(self) -> None:
        try:
            self._table().action_cursor_down()
        except Exception:
            pass

    def action_vim_up(self) -> None:
        try:
            self._table().action_cursor_up()
        except Exception:
            pass

    def action_vim_top(self) -> None:
        try:
            t = self._table()
            if t.row_count > 0:
                t.move_cursor(row=0)
        except Exception:
            pass

    def action_vim_bottom(self) -> None:
        try:
            t = self._table()
            if t.row_count > 0:
                t.move_cursor(row=t.row_count - 1)
        except Exception:
            pass

    def action_vim_page_down(self) -> None:
        try:
            t = self._table()
            new_row = min(t.cursor_row + 10, t.row_count - 1)
            if new_row >= 0:
                t.move_cursor(row=new_row)
        except Exception:
            pass

    def action_vim_page_up(self) -> None:
        try:
            t = self._table()
            new_row = max(t.cursor_row - 10, 0)
            t.move_cursor(row=new_row)
        except Exception:
            pass
