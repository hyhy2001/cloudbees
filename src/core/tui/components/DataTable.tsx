/**
 * DataTable — a scrollable table with a cursor row and vim-style navigation.
 * Ports the DataTable + VimNavMixin behaviour from the Textual TUI.
 *
 * Navigation (only when `active`):
 *   j / ↓        cursor down
 *   k / ↑        cursor up
 *   g            jump to first row
 *   G            jump to last row
 *   Ctrl+f       page down (10 rows)
 *   Ctrl+b       page up (10 rows)
 *
 * Controlled: the parent owns `cursor` and receives `onCursorChange`.
 * Cells carry their own color/dim so callers (e.g. job status) can colorize.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { THEME } from "../theme";
import { SYM } from "../symbols";

const PAGE = 10;

/** A single column definition: header label and fixed character width. */
export interface Column {
  header: string;
  width: number;
}

/** A single table cell with optional ANSI color and dim styling. */
export interface Cell {
  text: string;
  color?: string;
  dim?: boolean;
}

/**
 * Props for DataTable.
 *
 * Controlled cursor contract: the parent owns `cursor` and must wire
 * `onCursorChange` to update it. The table fires navigation callbacks but
 * never mutates cursor state itself.
 *
 * Nav keys (j/k/g/G/Ctrl+f/Ctrl+b) are only handled when `active` is true
 * (owning tab is focused and no modal overlay is open). Enter is intentionally
 * NOT handled here — it is owned by the screen keymap to avoid double-fire.
 *
 * `rowKeys` provides stable row identity (e.g. job name) so React can key rows
 * by logical identity rather than position; a refresh that reorders or inserts
 * rows updates in place instead of churning every row widget.
 */
export interface DataTableProps {
  columns: Column[];
  /** Each row has one Cell per column. */
  rows: Cell[][];
  /** Controlled cursor index; parent must update via onCursorChange. */
  cursor: number;
  onCursorChange: (index: number) => void;
  /** Only handle keys when true (the owning tab is active & no overlay). */
  active: boolean;
  /** Max visible rows (viewport). Default 12. */
  height?: number;
  /** Shown when there are no rows. */
  emptyText?: string;
  /**
   * Stable identity per row (e.g. job name). When provided, React keys rows by
   * identity instead of position, so a refresh that reorders/inserts rows
   * updates in place instead of churning every row widget (legacy P12).
   * Length should match `rows`; falls back to index when absent.
   */
  rowKeys?: string[];
}

function pad(s: string, width: number): string {
  if (s.length > width) return s.slice(0, Math.max(0, width - 1)) + "…";
  return s.padEnd(width, " ");
}

/** Scrollable table with a highlighted cursor row and vim-style keyboard nav. */
export const DataTable: React.FC<DataTableProps> = ({
  columns,
  rows,
  cursor,
  onCursorChange,
  active,
  height = 12,
  emptyText = "(no rows)",
  rowKeys,
}) => {
  const clamp = (i: number) => Math.max(0, Math.min(rows.length - 1, i));

  // Navigation only. Enter (and every action key) is owned by the screen's
  // keymap — the table never handles selection, so there's no double-fire.
  useInput(
    (input, key) => {
      if (rows.length === 0) return;
      if (input === "j" || key.downArrow) onCursorChange(clamp(cursor + 1));
      else if (input === "k" || key.upArrow) onCursorChange(clamp(cursor - 1));
      else if (input === "g") onCursorChange(0);
      else if (input === "G") onCursorChange(rows.length - 1);
      else if (key.ctrl && input === "f") onCursorChange(clamp(cursor + PAGE));
      else if (key.ctrl && input === "b") onCursorChange(clamp(cursor - PAGE));
    },
    { isActive: active },
  );

  // Compute the visible window around the cursor.
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(height / 2), Math.max(0, rows.length - height)),
  );
  const visible = rows.slice(start, start + height);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text> </Text>
        {columns.map((c, i) => (
          <Text key={i} color={THEME.keyhint} bold>
            {pad(c.header, c.width)}{" "}
          </Text>
        ))}
      </Box>

      {/* Rows */}
      {visible.map((row, vi) => {
        const rowIndex = start + vi;
        const isCursor = rowIndex === cursor;
        const rowKey = rowKeys?.[rowIndex] ?? rowIndex;
        return (
          <Box key={rowKey}>
            <Text color={isCursor ? THEME.active : THEME.dim}>{isCursor ? SYM.selected : " "}</Text>
            {row.map((cell, ci) => {
              const width = columns[ci]?.width ?? 10;
              const color = isCursor ? THEME.selectedFg : cell.dim ? THEME.dim : cell.color;
              return (
                <Text
                  key={ci}
                  color={color}
                  backgroundColor={isCursor ? THEME.selectedBg : undefined}
                  bold={isCursor}
                >
                  {pad(cell.text, width)}{" "}
                </Text>
              );
            })}
          </Box>
        );
      })}

      {rows.length === 0 && <Text color={THEME.dim}> {emptyText}</Text>}

      {/* Scroll hint */}
      {rows.length > height && (
        <Text color={THEME.dim}>
          {" "}
          {cursor + 1}/{rows.length}
        </Text>
      )}
    </Box>
  );
};
