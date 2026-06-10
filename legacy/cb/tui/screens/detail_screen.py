"""Detail screen — resource info + contextual action buttons.

Push this screen when user presses Enter on any DataTable row.
Press Esc / q to return to the list.
"""
from __future__ import annotations

from typing import Callable
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Button, Footer, Header, Static

from cb.tui.compat import SYM


class DetailScreen(Screen):
    """Generic resource detail + action screen.

    Args:
        title:   Resource display title shown at top.
        info:    List of (label, value) pairs shown as key-value table.
        actions: List of (key_char, button_label, callback) tuples.
    """

    BINDINGS = [
        ("escape", "go_back", "Back"),
        ("q",      "go_back", "Back"),
    ]

    def __init__(self, title: str, info: list, actions: list) -> None:
        super().__init__()
        self._detail_title = title
        self._info         = info
        self._actions      = actions
        self._action_map   = {k: fn for k, _, fn in actions}

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Vertical(id="detail-main"):
            yield Static(
                f" {SYM.arrow} {self._detail_title}",
                classes="pane-header",
            )
            # Key-value info table
            with Vertical(id="detail-info"):
                for label, value in self._info:
                    with Horizontal(classes="kv-row"):
                        yield Static(f"{label}:", classes="kv-label")
                        yield Static(str(value) if value else "—", classes="kv-value")

            # Action buttons
            if self._actions:
                yield Static(
                    f" {SYM.gear} Actions  [dim](press key or click)[/dim]",
                    classes="pane-header",
                )
                with Horizontal(id="detail-actions"):
                    for key, label, _fn in self._actions:
                        yield Button(
                            f"[{key.upper()}] {label}",
                            id=f"act-{key}",
                        )
                    yield Button(
                        f"[ESC] Back",
                        id="act-back",
                        variant="default",
                    )
            else:
                yield Static(f"[dim]{SYM.dot} No actions available.[/dim]")

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
            self.call_later(fn)

    def on_key(self, event) -> None:
        fn = self._action_map.get(event.key)
        if fn:
            event.stop()
            self.action_go_back()
            self.call_later(fn)

    def action_go_back(self) -> None:
        self.app.pop_screen()
