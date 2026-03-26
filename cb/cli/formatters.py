"""ASCII-only table and JSON formatters (zero external deps)."""

from __future__ import annotations
import json
from typing import Any


def format_table(headers: list[str], rows: list[list[str]], col_min: int = 6) -> str:
    """Render an ASCII table with + - | borders."""
    # Compute column widths
    widths = [max(col_min, len(h)) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            if i < len(widths):
                widths[i] = max(widths[i], len(str(cell)))

    sep = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    fmt = "|" + "|".join(f" {{:<{w}}} " for w in widths) + "|"

    lines = [sep, fmt.format(*headers), sep]
    for row in rows:
        padded = [str(row[i]) if i < len(row) else "" for i in range(len(headers))]
        lines.append(fmt.format(*padded))
    lines.append(sep)
    return "\n".join(lines)


def format_json(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False)


def format_kv(data: dict[str, Any]) -> str:
    """Key-value list for single-item detail views."""
    if not data:
        return "(no data)"
    key_width = max(len(k) for k in data)
    lines = [f"  {k:<{key_width}} : {v}" for k, v in data.items()]
    return "\n".join(lines)
