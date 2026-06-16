/**
 * DataTable — a scrollable table with a cursor row and vim-style navigation.
 * Ports the DataTable + VimNavMixin behaviour from the Textual TUI.
 *
 * Navigation (only when `active`):
 *   ↓            cursor down
 *   ↑            cursor up
 *   Home         jump to first row
 *   End          jump to last row
 *   Ctrl+f       page down (10 rows)
 *   Ctrl+b       page up (10 rows)
 *
 * Controlled: the parent owns `cursor` and receives `onCursorChange`.
 * Cells carry their own color/dim so callers (e.g. job status) can colorize.
 */

import React, { useCallback, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { THEME } from "../theme";
import { SYM } from "../symbols";

const PAGE = 10;

/**
 * A single column definition.
 *  - `width` is the fixed character width, OR the *minimum* width when `flex`.
 *  - `flex` columns split the terminal's leftover width evenly (after fixed
 *    columns + separators), so the table fills the screen instead of using
 *    hardcoded character counts. Falls back to `width` when no `tableWidth`
 *    is supplied (tests, piped output).
 */
export interface Column {
  header: string;
  width: number;
  flex?: boolean;
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
 * Nav keys (↑/↓/Home/End/Ctrl+f/Ctrl+b) are only handled when `active` is true
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
  /**
   * Total character width available to the table (from the real terminal, via
   * useDimensions). When set, `flex` columns expand to fill the leftover space
   * after fixed columns. When absent, every column uses its declared `width`.
   */
  tableWidth?: number;
  /** Set of selected rowKeys. When provided, renders selection markers. */
  selected?: Set<string>;
  /** Called when Space is pressed on the cursor row. Parent toggles the key. */
  onToggleSelect?: (key: string) => void;
}

/**
 * Resolve each column's effective render width. Fixed columns keep their
 * `width`; flex columns split the leftover terminal width evenly (never below
 * their declared `width`, which acts as a minimum). Pure + exported for tests.
 */
export function resolveColumnWidths(columns: Column[], tableWidth?: number): number[] {
  // No terminal width, or no flex columns → use declared widths verbatim.
  const flexIdx = columns.map((c, i) => (c.flex ? i : -1)).filter((i) => i >= 0);
  if (!tableWidth || flexIdx.length === 0) return columns.map((c) => c.width);

  // Budget: 2 leading indicator chars + 1 trailing space per column.
  const chrome = 2 + columns.length;
  const fixedTotal = columns.reduce((sum, c) => sum + (c.flex ? 0 : c.width), 0);
  const leftover = tableWidth - chrome - fixedTotal;
  const perFlexMin = columns.filter((c) => c.flex).reduce((s, c) => s + c.width, 0);

  // Not enough room to grow → fall back to declared minimums.
  if (leftover <= perFlexMin) return columns.map((c) => c.width);

  const each = Math.floor(leftover / flexIdx.length);
  return columns.map((c) => (c.flex ? Math.max(c.width, each) : c.width));
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
  tableWidth,
  selected,
  onToggleSelect,
}) => {
  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(rows.length - 1, i)),
    [rows.length],
  );
  // Memoize column widths — only recompute when columns or tableWidth change.
  const colWidths = useMemo(() => resolveColumnWidths(columns, tableWidth), [columns, tableWidth]);

  // Navigation only. Enter (and every action key) is owned by the screen's
  // keymap — the table never handles selection, so there's no double-fire.
  const handleInput = useCallback(
    (input: string, key: { downArrow: boolean; upArrow: boolean; ctrl: boolean }) => {
      if (rows.length === 0) return;
      if (input === " " && onToggleSelect) {
        const key = rowKeys?.[cursor];
        if (key) onToggleSelect(key);
        return;
      }
      if (key.downArrow) onCursorChange(clamp(cursor + 1));
      else if (key.upArrow) onCursorChange(clamp(cursor - 1));
      else if ((key as { home?: boolean }).home) onCursorChange(0);
      else if ((key as { end?: boolean }).end) onCursorChange(rows.length - 1);
      else if (key.ctrl && input === "f") onCursorChange(clamp(cursor + PAGE));
      else if (key.ctrl && input === "b") onCursorChange(clamp(cursor - PAGE));
    },
    [cursor, rows.length, onCursorChange, onToggleSelect, rowKeys, clamp],
  );
  useInput(handleInput, { isActive: active });

  // Compute the visible window around the cursor.
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(height / 2), Math.max(0, rows.length - height)),
  );
  const visible = rows.slice(start, start + height);

  const multi = (selected?.size ?? 0) > 0;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text color={multi ? THEME.keyhint : THEME.subtle} bold={multi}>
          {multi ? "S " : "  "}
        </Text>
        {columns.map((c, i) => (
          <Text key={i} color={THEME.keyhint} bold>
            {pad(c.header, colWidths[i] ?? c.width)}{" "}
          </Text>
        ))}
      </Box>

      {/* Header separator */}
      <Box>
        <Text color={THEME.subtle}>
          {"  "}
          {columns.map((_, i) => SYM.sep.repeat((colWidths[i] ?? columns[i]!.width) + 1)).join("")}
        </Text>
      </Box>

      {/* Rows */}
      {visible.map((row, vi) => {
        const rowIndex = start + vi;
        const isCursor = rowIndex === cursor;
        const rowKey = rowKeys?.[rowIndex] ?? rowIndex;
        const isSelected = typeof rowKey === "string" && (selected?.has(rowKey) ?? false);
        // ☑ = selected, ▶ = cursor (unselected), ☐ = selectable, space = not selectable
        const indicator = isSelected
          ? SYM.iconCheck
          : isCursor
            ? SYM.selected
            : onToggleSelect
              ? SYM.iconUncheck
              : " ";
        const indicatorColor = isSelected
          ? (isCursor ? THEME.selectedFg : THEME.success)
          : isCursor
            ? THEME.active
            : THEME.subtle;
        const rowBg = isCursor ? THEME.selectedBg : isSelected ? THEME.badgeWarnBg : undefined;
        return (
          <Box key={rowKey}>
            <Text color={indicatorColor} backgroundColor={rowBg}>{indicator}</Text>
            <Text color={THEME.subtle} backgroundColor={rowBg}> </Text>
            {row.map((cell, ci) => {
              const width = colWidths[ci] ?? columns[ci]?.width ?? 10;
              const color = isCursor
                ? THEME.selectedFg
                : isSelected
                  ? THEME.warning
                  : cell.dim
                    ? THEME.dim
                    : cell.color;
              return (
                <Text
                  key={ci}
                  color={color}
                  backgroundColor={rowBg}
                  bold={isCursor || isSelected}
                >
                  {pad(cell.text, width)}{" "}
                </Text>
              );
            })}
          </Box>
        );
      })}

      {rows.length === 0 && <Text color={THEME.dim}>{"  "}{emptyText}</Text>}

      {/* Scroll position — only shown when content overflows */}
      {rows.length > height && (
        <Box marginTop={0}>
          <Text color={THEME.dim}>
            {"  "}{cursor + 1}/{rows.length}
            {start > 0 ? `  ${SYM.arrowLeft} scroll up` : ""}
            {start + height < rows.length ? `  ${SYM.arrow} more below` : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
};
