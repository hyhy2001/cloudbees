/**
 * chdir parsing in getJobConfigSummary.
 *
 * The parser splits `cd <dir> && <rest>` from a shell command into
 * summary.chdir + summary.shell_cmd. These tests exercise the regex
 * (service.ts line ~526) via the exported helper — to avoid importing
 * the full service (which needs fast-xml-parser), we test the regex
 * directly with the same pattern used in production code.
 */

import { describe, test, expect } from "bun:test";

// Mirror of the production regex used in getJobConfigSummary:
//   /^cd\s+(.+?)\s+&&\s+([\s\S]*)$/
function parseCdChdir(cmd: string): { chdir: string; shell_cmd: string } | null {
  const m = cmd.match(/^cd\s+(.+?)\s+&&\s+([\s\S]*)$/);
  if (!m) return null;
  return { chdir: m[1]!.trim(), shell_cmd: m[2]! };
}

describe("chdir parsing from shell command", () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  test("plain cd && cmd", () => {
    const r = parseCdChdir("cd /data/project && make build");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/data/project");
    expect(r!.shell_cmd).toBe("make build");
  });

  test("path with spaces in dir", () => {
    const r = parseCdChdir("cd /my folder/sub dir && echo hi");
    expect(r).not.toBeNull();
    // Regex is non-greedy (.+?): stops at first ` && `, so chdir = "/my folder/sub dir"
    expect(r!.chdir).toBe("/my folder/sub dir");
    expect(r!.shell_cmd).toBe("echo hi");
  });

  test("path with trailing slash", () => {
    const r = parseCdChdir("cd /opt/app/ && ./run.sh");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/opt/app/");
    expect(r!.shell_cmd).toBe("./run.sh");
  });

  test("relative path", () => {
    const r = parseCdChdir("cd src/scripts && python3 test.py");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("src/scripts");
    expect(r!.shell_cmd).toBe("python3 test.py");
  });

  test("multiline shell_cmd after cd", () => {
    const cmd = "cd /app && npm install\nnpm run build";
    const r = parseCdChdir(cmd);
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/app");
    expect(r!.shell_cmd).toBe("npm install\nnpm run build");
  });

  test("shell_cmd containing && (not confused with the separator)", () => {
    // Non-greedy .+? stops at FIRST ` && `, so second && stays in shell_cmd.
    const r = parseCdChdir("cd /app && echo foo && echo bar");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/app");
    expect(r!.shell_cmd).toBe("echo foo && echo bar");
  });

  test("dir with environment variable", () => {
    const r = parseCdChdir("cd $HOME/project && ./deploy.sh");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("$HOME/project");
    expect(r!.shell_cmd).toBe("./deploy.sh");
  });

  // ── No-match cases (no cd prefix) ─────────────────────────────────────────

  test("no cd prefix → returns null", () => {
    expect(parseCdChdir("echo hello")).toBeNull();
  });

  test("&& but no leading cd → returns null", () => {
    expect(parseCdChdir("export X=1 && make")).toBeNull();
  });

  test("cd alone with no && → returns null", () => {
    expect(parseCdChdir("cd /tmp")).toBeNull();
  });

  test("empty string → returns null", () => {
    expect(parseCdChdir("")).toBeNull();
  });

  test("cd with extra whitespace around &&", () => {
    // Multiple spaces around && are consumed by \s+
    const r = parseCdChdir("cd /app  &&  npm test");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/app");
    expect(r!.shell_cmd).toBe("npm test");
  });
});
