import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv, CB_DB_PATH: "/tmp/bee-ask-cli-test.db" },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: out + err };
}

describe("bee ask CLI", () => {
  test("returns command answer with usage", async () => {
    const { code, out } = await runCli(["ask", "stop", "build"]);
    expect(code).toBe(0);
    expect(out).toContain("bee job stop <name>");
    expect(out).not.toContain("concepts.md");
  });

  test("returns concept answer with explanation text", async () => {
    const { code, out } = await runCli(["ask", "what", "is", "a", "profile"]);
    expect(code).toBe(0);
    expect(out).toContain("A profile is a saved login target");
    expect(out).not.toContain("concepts.md");
  });

  test("supports --json output", async () => {
    const { code, out } = await runCli(["ask", "switch", "profile", "--json"]);
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.query).toBe("switch profile");
    expect(typeof data.answer).toBe("string");
    expect(Array.isArray(data.hits)).toBe(true);
    expect(data.hits.length).toBeGreaterThan(0);
  });

  test("can include raw doc chunks only when explicitly enabled", async () => {
    const { code, out } = await runCli(["ask", "global", "keys", "tab"], { BEE_ASK_INCLUDE_DOC_CHUNKS: "1" });
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(0);
  });
});
