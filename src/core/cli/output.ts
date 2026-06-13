/**
 * Terminal output — color theme, error printing, and the default table formatter.
 * Mirrors legacy/cb/cli/console.py + formatters.py (Rich → chalk + cli-table3).
 */
import chalk from "chalk";
import Table from "cli-table3";
import type { OutputFormatter } from "../../registry/types";
import { AuthError } from "../api/errors";

// --- Color theme (mirrors Rich custom_theme) ---
export const theme = {
  info: chalk.dim.cyan,
  warning: chalk.yellow,
  error: chalk.bold.red,
  success: chalk.green,
  heading: chalk.bold.cyan,
};

function debugTracebackEnabled(): boolean {
  const v = (process.env.BEE_DEBUG_TRACEBACK ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Print a styled error. Full stack only in debug mode. Auth errors get a friendly line. */
export function printError(msg: string, err?: unknown): void {
  if (err !== undefined && err !== null) {
    const errText = (err instanceof Error ? err.message : String(err)) || msg;
    if (err instanceof AuthError || errText.includes("Not logged in")) {
      console.error(theme.error("AUTH ERROR:") + " " + errText);
      return;
    }
    if (debugTracebackEnabled() && err instanceof Error) {
      console.error(err.stack ?? errText);
      return;
    }
    console.error(theme.error("ERROR:") + " " + errText);
    return;
  }
  console.error(theme.error("ERROR:") + " " + msg);
}

export function printInfo(msg: string): void {
  console.log(theme.info(msg));
}
export function printSuccess(msg: string): void {
  console.log(theme.success(msg));
}
export function printWarning(msg: string): void {
  console.log(theme.warning(msg));
}
/** Plain stdout line — no colour, for neutral status messages (e.g. "Cancelled."). */
export function printMessage(msg: string): void {
  console.log(msg);
}

/**
 * Read a line from stdin with echo disabled (for passwords/tokens).
 * Falls back to a visible prompt if raw mode is unavailable.
 */
export async function readHidden(promptText: string): Promise<string> {
  process.stderr.write(promptText);
  const proc = Bun.spawn(["bash", "-c", 'stty -echo; read line; stty echo; echo "$line"'], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(proc.stdout).text();
  process.stderr.write("\n");
  return output.trimEnd();
}

// --- Default table formatter (the built-in "table" format) ---

export const tableFormatter: OutputFormatter = {
  table(headers: string[], rows: string[][]): string {
    const t = new Table({
      head: headers.map((h) => theme.heading(h)),
      style: { head: [], border: [] },
    });
    for (const row of rows) t.push(row.map((c) => String(c ?? "")));
    return t.toString();
  },

  kv(data: Record<string, unknown>): string {
    const t = new Table({ style: { head: [], border: [] } });
    const entries = Object.entries(data);
    if (entries.length === 0) {
      t.push(["(no data)", ""]);
    } else {
      for (const [k, v] of entries) t.push([theme.heading(String(k)), String(v ?? "")]);
    }
    return t.toString();
  },

  message(text: string, level: "info" | "error" | "success" | "warning"): string {
    return theme[level](text);
  },
};

/** JSON formatter (the built-in "json" format) — for scripting. */
export const jsonFormatter: OutputFormatter = {
  table(headers: string[], rows: string[][]): string {
    const objs = rows.map((row) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => (o[h] = row[i] ?? ""));
      return o;
    });
    return JSON.stringify(objs, null, 2);
  },
  kv(data: Record<string, unknown>): string {
    return JSON.stringify(data, null, 2);
  },
  message(text: string): string {
    return JSON.stringify({ message: text });
  },
};
