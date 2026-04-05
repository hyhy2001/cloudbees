import os
from typing import Optional
from rich.console import Console
from rich.theme import Theme
from rich.panel import Panel

custom_theme = Theme({
    "info": "dim cyan",
    "warning": "yellow",
    "error": "bold red",
    "success": "green",
})

# We enable unicode output by default as requested.
console = Console(theme=custom_theme)

def print_error(msg: str, exc: Optional[Exception] = None) -> None:
    """Print a styled error panel. If exc is provided, can print traceback."""
    if exc:
        console.print_exception()
    else:
        console.print(Panel(f"[error]ERROR:[/error] {msg}", border_style="red"))
