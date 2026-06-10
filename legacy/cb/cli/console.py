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
    """Print a styled error panel. Traceback is shown only in debug mode."""
    debug_tb = os.getenv("BEE_DEBUG_TRACEBACK", "").lower() in ("1", "true", "yes", "on")

    # Friendly auth/session errors by default (no traceback noise).
    if exc is not None:
        err_text = str(exc) or msg
        err_name = exc.__class__.__name__
        if err_name == "AuthError" or "Not logged in" in err_text:
            console.print(Panel(f"[error]AUTH ERROR:[/error] {err_text}", border_style="red"))
            return
        if debug_tb:
            console.print_exception()
            return
        console.print(Panel(f"[error]ERROR:[/error] {err_text}", border_style="red"))
        return

    console.print(Panel(f"[error]ERROR:[/error] {msg}", border_style="red"))
