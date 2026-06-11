/**
 * Pure helpers for the String-parameter list editor (ParamListEditor).
 *
 *   ParamListEditor (overlay) ── add/remove/update ──► StringParamDef[]
 *                                      ▲
 *                              these pure functions
 *
 * Kept React-free so the list mutations unit-test without a TTY (same pattern as
 * resolveCursor / nextInterval / appendChunk). The component is a thin shell that
 * owns a `StringParamDef[]` in state and calls these to transform it.
 */

import type { StringParamDef } from "../../../plugins/job/types";

/** Append a blank parameter row; returns a new array. */
export function addParam(params: readonly StringParamDef[]): StringParamDef[] {
  return [...params, { name: "", defaultValue: "", description: "" }];
}

/** Remove the row at `index` (no-op if out of range); returns a new array. */
export function removeParam(
  params: readonly StringParamDef[],
  index: number,
): StringParamDef[] {
  if (index < 0 || index >= params.length) return [...params];
  return params.filter((_, i) => i !== index);
}

/** Patch one field of the row at `index`; returns a new array. */
export function updateParam(
  params: readonly StringParamDef[],
  index: number,
  field: keyof StringParamDef,
  value: string,
): StringParamDef[] {
  if (index < 0 || index >= params.length) return [...params];
  return params.map((p, i) => (i === index ? { ...p, [field]: value } : p));
}

/**
 * Drop rows with a blank name (they can't be submitted) and trim names. Used
 * just before returning the editor's result so half-typed rows don't leak out.
 */
export function finalizeParams(params: readonly StringParamDef[]): StringParamDef[] {
  return params
    .map((p) => ({ ...p, name: p.name.trim() }))
    .filter((p) => p.name.length > 0);
}
