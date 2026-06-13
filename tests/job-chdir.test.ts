/**
 * chdir parsing in getJobConfigSummary.
 *
 * The parser splits a leading `cd "..." && <rest>` (quoted, new format) or
 * `cd /path && <rest>` (unquoted, legacy) from a shell command into
 * summary.chdir + summary.shell_cmd. These tests exercise the regex pair
 * (service.ts ~line 526) via a local mirror of the production logic.
 */

import { describe, test, expect } from "bun:test";

// Mirror of the production regex pair used in getJobConfigSummary.
// Quoted form takes priority; unquoted form is the legacy fallback.
function parseCdChdir(cmd: string): { chdir: string; shell_cmd: string } | null {
  const m = cmd.match(/^cd\s+"(.+?)"\s+&&\s+([\s\S]*)$/) ??
    cmd.match(/^cd\s+(\S+)\s+&&\s+([\s\S]*)$/);
  if (!m) return null;
  return { chdir: m[1]!.trim(), shell_cmd: m[2]! };
}

describe("chdir parsing from shell command", () => {
  // ── Quoted form (new — built by buildFreestyleXml) ───────────────────────

  test("quoted path with spaces (new format)", () => {
    const r = parseCdChdir('cd "/my folder/sub dir" && echo hi');
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/my folder/sub dir");
    expect(r!.shell_cmd).toBe("echo hi");
  });

  test("quoted plain path (new format)", () => {
    const r = parseCdChdir('cd "/data/project" && make build');
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/data/project");
    expect(r!.shell_cmd).toBe("make build");
  });

  test("quoted path with trailing slash (new format)", () => {
    const r = parseCdChdir('cd "/opt/app/" && ./run.sh');
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/opt/app/");
    expect(r!.shell_cmd).toBe("./run.sh");
  });

  test("quoted path — shell_cmd containing && (new format)", () => {
    // Non-greedy inside quotes stops at `"`, so second && stays in shell_cmd.
    const r = parseCdChdir('cd "/app" && echo foo && echo bar');
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/app");
    expect(r!.shell_cmd).toBe("echo foo && echo bar");
  });

  test("quoted multiline shell_cmd after cd (new format)", () => {
    const cmd = 'cd "/app" && npm install\nnpm run build';
    const r = parseCdChdir(cmd);
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/app");
    expect(r!.shell_cmd).toBe("npm install\nnpm run build");
  });

  test("quoted path with env var (new format)", () => {
    const r = parseCdChdir('cd "$HOME/project" && ./deploy.sh');
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("$HOME/project");
    expect(r!.shell_cmd).toBe("./deploy.sh");
  });

  // ── Unquoted form (legacy — produced before the quoting fix) ─────────────

  test("unquoted plain path (legacy)", () => {
    const r = parseCdChdir("cd /data/project && make build");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/data/project");
    expect(r!.shell_cmd).toBe("make build");
  });

  test("unquoted relative path (legacy)", () => {
    const r = parseCdChdir("cd src/scripts && python3 test.py");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("src/scripts");
    expect(r!.shell_cmd).toBe("python3 test.py");
  });

  test("unquoted — shell_cmd containing && (legacy)", () => {
    const r = parseCdChdir("cd /app && echo foo && echo bar");
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/app");
    expect(r!.shell_cmd).toBe("echo foo && echo bar");
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

  test("quoted cd with extra whitespace around && (new format)", () => {
    // Multiple spaces around && are consumed by \s+
    const r = parseCdChdir('cd "/app"  &&  npm test');
    expect(r).not.toBeNull();
    expect(r!.chdir).toBe("/app");
    expect(r!.shell_cmd).toBe("npm test");
  });
});
