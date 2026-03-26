"""Detail screen -- shows resource info and contextual action buttons.

Push this screen when user presses Enter on any DataTable row.
Press Escape or Q to return to the list.
"""
from __future__ import annotations

from typing import Callable
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Button, Footer, Header, Static
from textual.containers import Horizontal, Vertical
from textual.keys import Keys


class DetailScreen(Screen):
    """Generic resource detail + action screen.

    Args:
        title:   Resource display title shown at top.
        info:    List of (label, value) pairs shown as key-value table.
        actions: List of (key_char, button_label, callback) tuples.
                 Pressing the key or clicking the button calls callback()
                 after this screen is popped.

    Navigation:
        Escape / q -- go back
        Action key  -- execute action and go back
    """

    BINDINGS = [
        ("escape", "go_back", "Back"),
        ("q",      "go_back", "Back"),
    ]

    def __init__(
        self,
        title: str,
        info: list,
        actions: list,
    ) -> None:
        super().__init__()
        self._detail_title = title
        self._info         = info           # [(label, value), ...]
        self._actions      = actions        # [(key, label, fn), ...]
        self._action_map   = {k: fn for k, _, fn in actions}

    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical(id="detail-main"):
            yield Static(
                f"--- {self._detail_title} ---",
                classes="panel-title",
            )

            # Key-value info table
            with Vertical(id="detail-info"):
                for label, value in self._info:
                    with Horizontal(classes="kv-row"):
                        yield Static(f"{label}:", classes="kv-label")
                        yield Static(str(value) if value else "-", classes="kv-value")

            yield Static(" ", id="detail-spacer")

            # Action buttons row
            if self._actions:
                yield Static("--- Actions ---", classes="panel-title")
                with Horizontal(id="detail-actions"):
                    for key, label, _fn in self._actions:
                        yield Button(
                            f"[{key.upper()}] {label}",
                            id=f"act-{key}",
                        )
                    yield Button("[ESC] Back", id="act-back", variant="default")
            else:
                yield Static("(no actions available)", classes="dim")

        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id
        if btn_id == "act-back":
            self.action_go_back()
            return
        key = btn_id.replace("act-", "", 1)
        fn  = self._action_map.get(key)
        if fn:
            self.action_go_back()
            # Small delay so the screen pop renders before action
            self.call_later(fn)

    def on_key(self, event) -> None:
        """Allow pressing the action key directly (not just button click)."""
        fn = self._action_map.get(event.key)
        if fn:
            event.stop()
            self.action_go_back()
            self.call_later(fn)

    def action_go_back(self) -> None:
        self.app.pop_screen()
