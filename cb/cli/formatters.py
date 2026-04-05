"""Rich-based table and JSON formatters."""

from __future__ import annotations
import json
from typing import Any
from rich.table import Table
from rich import box

def format_table(headers: list[str], rows: list[list[str]], col_min: int = 6) -> Table:
    """Render a Rich table."""
    table = Table(box=box.ROUNDED, show_header=True, header_style="bold cyan")
    for header in headers:
        table.add_column(header)
        
    for row in rows:
        table.add_row(*(str(cell) for cell in row))
        
    return table

def format_json(data: Any) -> str:
    """Returns raw JSON for scripting."""
    return json.dumps(data, indent=2, ensure_ascii=False)

def format_kv(data: dict[str, Any]) -> Table:
    """Key-value list for single-item detail views."""
    table = Table(box=box.SIMPLE, show_header=False)
    table.add_column("Key", style="bold cyan")
    table.add_column("Value")
    
    if not data:
        table.add_row("(no data)", "")
        return table
        
    for k, v in data.items():
        table.add_row(str(k), str(v))
    return table
