/**
 * Base DTO utilities.
 * Provides type-safe narrowing helpers and a generic pick() factory
 * that mirrors Python BaseDTO.from_dict (filters unknown keys, applies defaults).
 */

// --- Narrowing helpers ---

/** Coerce an unknown API value to a string; `null`/`undefined` → `def`, other types via `String()`. */
export function str(v: unknown, def = ""): string {
  if (v === null || v === undefined) return def;
  if (typeof v === "string") return v;
  return String(v);
}

/** Coerce an unknown API value to a number; `null`/`undefined` or `NaN` → `def`. */
export function num(v: unknown, def = 0): number {
  if (v === null || v === undefined) return def;
  if (typeof v === "number") return v;
  const n = Number(v);
  return isNaN(n) ? def : n;
}

/** Coerce an unknown API value to a boolean; `null`/`undefined` → `def`, other types via `Boolean()`. */
export function bool(v: unknown, def = false): boolean {
  if (v === null || v === undefined) return def;
  if (typeof v === "boolean") return v;
  return Boolean(v);
}

/** Return the value if it is an array, otherwise `def`. Does not validate element types. */
export function arr<T>(v: unknown, def: T[] = []): T[] {
  if (Array.isArray(v)) return v as T[];
  return def;
}

/** Safe nested get: get(data, "lastBuild", "number") */
export function nested(data: unknown, ...keys: string[]): unknown {
  let cur: unknown = data;
  for (const key of keys) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// --- Generic pick factory ---

/**
 * Constructs an object containing only the listed keys from data,
 * falling back to the provided defaults for missing/undefined values.
 * Mirrors Python BaseDTO.from_dict: unknown keys are silently ignored;
 * missing keys use dataclass defaults.
 */
export function pick<T extends object>(
  data: Record<string, unknown>,
  defaults: T,
): T {
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const val = data[key as string];
    if (val !== undefined) {
      (result as Record<string, unknown>)[key as string] = val;
    }
  }
  return result;
}

/** Trivial identity serialiser — mirrors Python to_dict / dataclasses.asdict. */
export function toDict<T extends object>(dto: T): Record<string, unknown> {
  return { ...dto } as Record<string, unknown>;
}
