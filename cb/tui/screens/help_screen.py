"""Help screen — keyboard shortcuts reference."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Static
from textual.containers import Vertical

from cb.tui.compat import SYM


_HELP_CONTENT = f"""
[bold blue]bee {SYM.bee} — CloudBees TUI Help[/bold blue]

[bold]Global Keys[/bold]
  [cyan]q[/cyan]              Quit (session preserved)
  [cyan]l[/cyan]              Login
  [cyan]x[/cyan]              Logout (clears session)
  [cyan]1–5[/cyan]            Jump directly to tab
  [cyan]Tab / Shift+Tab[/cyan] Cycle tabs forward / back
  [cyan]F5[/cyan]             Force refresh (clears cache for active tab)
  [cyan]F2[/cyan]             Toggle dark/light mode
  [cyan]?[/cyan]              Show this help
  [cyan]Esc[/cyan]            Close modal / go back

[bold]Navigation (all tables)[/bold]
  [cyan]j / ↓[/cyan]          Move cursor down
  [cyan]k / ↑[/cyan]          Move cursor up
  [cyan]g[/cyan]              Jump to first row
  [cyan]G[/cyan]              Jump to last row
  [cyan]Ctrl+f[/cyan]         Page down (10 rows)
  [cyan]Ctrl+b[/cyan]         Page up (10 rows)
  [cyan]Enter[/cyan]          Open detail + actions screen

[bold]Jobs Tab (4)[/bold]
  [cyan]r[/cyan]   Run selected job
  [cyan]s[/cyan]   Stop last build
  [cyan]l[/cyan]   View build log (colour-coded)
  [cyan]n[/cyan]   Create new job (freestyle / pipeline / folder)
  [cyan]d[/cyan]   Delete job
  [cyan]a[/cyan]   Toggle Mine / All

[bold]Nodes Tab (3)[/bold]
  [cyan]o[/cyan]   Toggle node online/offline
  [cyan]n[/cyan]   Create new node
  [cyan]d[/cyan]   Delete node
  [cyan]a[/cyan]   Toggle Mine / All

[bold]Credentials Tab (2)[/bold]
  [cyan]c[/cyan]   Create credential
  [cyan]d[/cyan]   Delete credential
  [cyan]S[/cyan]   Toggle store: user ↔ system  (Shift+s)
  [cyan]a[/cyan]   Toggle Mine / All

[bold]Settings Tab (5)[/bold]
  [cyan]F5[/cyan]  Refresh system info
  [cyan]c[/cyan]   Clear all cache

[bold]Log Viewer[/bold]
  [cyan]j/k[/cyan]        Scroll down/up
  [cyan]g/G[/cyan]        Scroll to top/bottom
  [cyan]Ctrl+f/b[/cyan]   Page down/up
  [cyan]F5[/cyan]         Refresh log
  [cyan]q/Esc[/cyan]      Return to jobs

[dim]Colour codes in job status:[/dim]
  [green]{SYM.ok} OK[/green]   [red]{SYM.fail} FAIL[/red]   [yellow]{SYM.warn} WARN[/yellow]   [dim]{SYM.aborted} ABT[/dim]   [dim]{SYM.notbuilt} NEW[/dim]

[dim]Press Esc or ? to close[/dim]
"""


class HelpScreen(ModalScreen):
    """Help overlay — keyboard reference card."""

    BINDINGS = [
        ("escape", "dismiss", "Close"),
        ("q",      "dismiss", "Close"),
        ("?",      "dismiss", "Close"),
    ]

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Static(_HELP_CONTENT)
