import readline from "node:readline";
import { isJsonOutput, printError } from "./output";

/** Prompt a yes/no question; returns true iff user answers "y" or "yes". */
export function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
    });
  });
}

/**
 * Confirmation gate for destructive commands. When `--yes` is passed, proceeds
 * without prompting. In JSON output mode a prompt would corrupt stdout and hang
 * a non-interactive script, so `--yes` is mandatory there: without it we emit a
 * parseable error and exit non-zero. Otherwise falls back to an interactive
 * yes/no prompt and returns the user's answer.
 */
export async function confirmAction(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (isJsonOutput()) {
    printError("--yes is required for this command when using --json.");
    process.exit(1);
  }
  return confirm(question);
}
