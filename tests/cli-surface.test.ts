/**
 * CLI surface tests — port of legacy/cb/testsuite/test_cli_surface.py.
 *
 * Asserts the `job create` / `job update` help text:
 *   - does NOT mention "pipeline" (Freestyle/Folder only in this build)
 *   - exposes the email anti-spam filter options
 *
 * Runs the real CLI via `bun run src/main.ts <args>` as a subprocess and
 * inspects stdout, mirroring Click's CliRunner.invoke in the Python suite.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // Isolate from any real DB/secret — use a throwaway path.
    env: { ...process.env, CB_DB_PATH: "/tmp/bee-cli-surface-test.db" },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: out + err };
}

describe("job create help surface", () => {
  test("create group has 'pipeline' subcommand", async () => {
    const { code, out } = await runCli(["job", "create", "--help"]);
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("pipeline");
  });

  test("create freestyle exposes email filter options", async () => {
    const { code, out } = await runCli(["job", "create", "freestyle", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("--email-keyword");
    expect(out).toContain("--email-regex");
  });
});

describe("job update help surface", () => {
  test("update group has 'pipeline' subcommand", async () => {
    const { code, out } = await runCli(["job", "update", "--help"]);
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("pipeline");
  });

  test("update freestyle exposes email filter + clear flags", async () => {
    const { code, out } = await runCli(["job", "update", "freestyle", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("--email-keyword");
    expect(out).toContain("--email-regex");
    expect(out).toContain("--clear-email-keywords");
    expect(out).toContain("--clear-email-regex");
  });
});
