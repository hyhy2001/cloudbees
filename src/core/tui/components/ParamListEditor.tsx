/**
 * ParamListEditor — a full-screen overlay for editing a job's String build
 * parameters (StringParamDef[]). Rendered in place of a screen (like LogViewer),
 * it owns all input via ctx.setInputCaptured so the shell's global keys don't
 * fire while the user is editing.
 *
 *   list mode:  j/k move · i add row · d delete row · e edit row · Enter done · Esc cancel
 *   edit mode:  a 3-field FormModal (name / default / description) for one row
 *
 * The list mutations are the pure helpers in data/param-list.ts; this component
 * is the thin interactive shell around a StringParamDef[] in state.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FC } from "react";
import { Modal } from "./Modal";
import { FormModal } from "./FormModal";
import { THEME } from "../theme";
import { SYM } from "../symbols";
import type { StringParamDef } from "../../../plugins/job/types";
import { addParam, removeParam, updateParam, finalizeParams } from "../data/param-list";

export interface ParamListEditorProps {
  /** Initial parameter rows (e.g. parsed from the job config, or []). */
  initial: StringParamDef[];
  /** Called with the finalized rows on confirm, or null on cancel. */
  onResult: (params: StringParamDef[] | null) => void;
  /** Mark the overlay as owning input (suspends shell global keys). */
  setInputCaptured: (captured: boolean) => void;
}

/** Full-screen String-parameter editor overlay. */
export const ParamListEditor: FC<ParamListEditorProps> = ({
  initial,
  onResult,
  setInputCaptured,
}) => {
  const [params, setParams] = useState<StringParamDef[]>(initial);
  const [cursor, setCursor] = useState(0);
  // When set, the row index currently being edited via the FormModal.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Own input while open; release on unmount.
  useEffect(() => {
    setInputCaptured(true);
    return () => setInputCaptured(false);
  }, [setInputCaptured]);

  const clampCursor = (n: number, len: number) => Math.max(0, Math.min(len - 1, n));

  // Open the per-row FormModal for an existing row.
  const openEdit = (index: number) => setEditingIndex(index);

  useInput(
    (input, key) => {
      // While the per-row form is open, it owns input (its own useInput).
      if (editingIndex !== null) return;

      if (key.escape) {
        onResult(null);
        return;
      }
      if (key.return) {
        onResult(finalizeParams(params));
        return;
      }
      if (input === "j" || key.downArrow) {
        setCursor((c) => clampCursor(c + 1, params.length));
        return;
      }
      if (input === "k" || key.upArrow) {
        setCursor((c) => clampCursor(c - 1, params.length));
        return;
      }
      if (input === "i") {
        // Add a blank row and immediately open its editor.
        const next = addParam(params);
        setParams(next);
        setEditingIndex(next.length - 1);
        setCursor(next.length - 1);
        return;
      }
      if (input === "d") {
        if (params.length === 0) return;
        const next = removeParam(params, cursor);
        setParams(next);
        setCursor((c) => clampCursor(c, next.length));
        return;
      }
      if (input === "e") {
        if (params.length > 0) openEdit(cursor);
        return;
      }
    },
    { isActive: editingIndex === null },
  );

  // Per-row edit form.
  if (editingIndex !== null) {
    const row = params[editingIndex] ?? { name: "", defaultValue: "", description: "" };
    return (
      <FormModal
        title={`${SYM.gear} Parameter ${editingIndex + 1}`}
        fields={[
          { name: "name", label: "Name", required: true, initial: row.name },
          { name: "defaultValue", label: "Default", initial: row.defaultValue ?? "" },
          { name: "description", label: "Description", initial: row.description ?? "" },
        ]}
        onResult={(values) => {
          if (values) {
            let next = updateParam(params, editingIndex, "name", values.name ?? "");
            next = updateParam(next, editingIndex, "defaultValue", values.defaultValue ?? "");
            next = updateParam(next, editingIndex, "description", values.description ?? "");
            setParams(next);
          } else if (params[editingIndex] && !params[editingIndex].name.trim()) {
            // Cancelled a freshly-added blank row → drop it.
            setParams(removeParam(params, editingIndex));
            setCursor((c) => clampCursor(c, params.length - 1));
          }
          setEditingIndex(null);
        }}
      />
    );
  }

  return (
    <Modal title={`${SYM.gear} Edit Build Parameters`}>
      {params.length === 0 ? (
        <Text color={THEME.dim}>No parameters. Press i to add one.</Text>
      ) : (
        params.map((p, i) => {
          const on = i === cursor;
          return (
            <Box key={i}>
              <Text color={on ? THEME.active : THEME.dim}>
                {on ? SYM.arrow : " "} {String(i + 1).padEnd(2)}
              </Text>
              <Text color={THEME.normal}>
                {(p.name || "(unnamed)").padEnd(20)}
              </Text>
              <Text color={THEME.dim}>
                default={p.defaultValue || "—"}
                {p.description ? ` · ${p.description}` : ""}
              </Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text color={THEME.dim}>
          j/k move · i add · e edit · d delete · Enter save · Esc cancel
        </Text>
      </Box>
    </Modal>
  );
};
