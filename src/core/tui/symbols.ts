/**
 * Terminal symbol set — Unicode by default, ASCII fallback.
 * Port of legacy/cb/tui/compat.py.
 *
 * Unicode is ON by default on UTF-8 terminals; opt out with BEE_ASCII=1.
 */

function isAsciiForced(): boolean {
  const v = (process.env.BEE_ASCII ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function hasUtf8(): boolean {
  // process.stdout has no `encoding` in the same sense as Python; rely on locale.
  const lang = (process.env.LC_ALL || process.env.LANG || "").toUpperCase();
  return lang.includes("UTF");
}

/** True when Unicode symbols should be used. */
export const UNICODE_MODE = hasUtf8() && !isAsciiForced();

export interface Symbols {
  ok: string;
  fail: string;
  warn: string;
  aborted: string;
  notbuilt: string;
  disabled: string;
  running: string;
  gear: string;
  warnTri: string;
  bee: string;
  sep: string;
  pipe: string;
  arrow: string;
  dot: string;
  online: string;
  offline: string;
  selected: string;
  spinnerFrames: string[];
}

const UNICODE_SYMBOLS: Symbols = {
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  aborted: "◇",
  notbuilt: "○",
  disabled: "⊘",
  running: "●",
  gear: "⚙",
  warnTri: "▲",
  bee: "🐝",
  sep: "─",
  pipe: "│",
  arrow: "›",
  dot: "·",
  online: "◉",
  offline: "◌",
  selected: "▶",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII_SYMBOLS: Symbols = {
  ok: "[OK]",
  fail: "[!!]",
  warn: "[~~]",
  aborted: "[--]",
  notbuilt: "[  ]",
  disabled: "[DI]",
  running: "[>>]",
  gear: "[**]",
  warnTri: "[/!]",
  bee: "bee",
  sep: "-",
  pipe: "|",
  arrow: ">",
  dot: ".",
  online: "[O]",
  offline: "[ ]",
  selected: ">",
  spinnerFrames: ["[ |  ]", "[ /  ]", "[ -- ]", "[ \\  ]"],
};

/** Return the symbol set for the given mode. Exposed for testing. */
export function makeSymbols(unicode: boolean): Symbols {
  return unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
}

/** Active symbol set, chosen once at module load. */
export const SYM: Symbols = makeSymbols(UNICODE_MODE);

/** Border style token for Ink <Box borderStyle>. */
export function borderStyle(): "round" | "classic" {
  return UNICODE_MODE ? "round" : "classic";
}
