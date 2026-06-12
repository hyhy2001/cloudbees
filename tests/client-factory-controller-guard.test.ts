/**
 * Controller-required guard for getClient().
 *
 * When a session exists but NO active controller is selected, getClient with
 * useController:true must THROW (never silently fall back to the server root),
 * so credential/node/job operations are blocked until a controller is chosen.
 * useController:false must still work (controller/system plugins need it to
 * list controllers BEFORE one is selected).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TMP_DIR = mkdtempSync(join(tmpdir(), "bee-ctrl-guard-test-"));
const DB_PATH = join(TMP_DIR, "test.db");

import { initDb, getConnection } from "../src/core/db/connection";
import { saveSession } from "../src/core/session/session";
import { setSetting } from "../src/core/db/repositories/settings-repo";
import { getClient, getActiveController } from "../src/core/client-factory";
import { CBError } from "../src/core/api/errors";

beforeAll(() => {
  initDb(DB_PATH);
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function reset(): void {
  const db = getConnection(DB_PATH);
  try {
    db.run("DELETE FROM settings WHERE key LIKE 'session%' OR key = 'active_profile'");
    db.run("DELETE FROM settings WHERE key LIKE 'active_controller%'");
  } finally {
    db.close();
  }
}

describe("getClient controller guard", () => {
  test("throws CBError when logged in but no controller selected", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    expect(getActiveController(DB_PATH)).toBeNull();
    expect(() => getClient({ useController: true, dbPath: DB_PATH })).toThrow(CBError);
    expect(() => getClient({ useController: true, dbPath: DB_PATH })).toThrow(
      /No active controller selected/,
    );
  });

  test("useController:false works without a controller (server-root client)", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    const client = getClient({ useController: false, dbPath: DB_PATH });
    expect(client.baseUrl).toBe("https://a.example.com");
  });

  test("uses the controller URL once one is selected", () => {
    reset();
    saveSession("tok-a", "alpha", "https://a.example.com", "alice", DB_PATH);
    setSetting("active_controller.alpha", "ctrl1", DB_PATH);
    setSetting("active_controller_url.alpha", "https://a.example.com/cjoc/job/ctrl1/", DB_PATH);
    expect(getActiveController(DB_PATH)).toEqual([
      "ctrl1",
      "https://a.example.com/cjoc/job/ctrl1/",
    ]);
    // CloudBeesClientImpl strips trailing slashes from baseUrl.
    const client = getClient({ useController: true, dbPath: DB_PATH });
    expect(client.baseUrl).toBe("https://a.example.com/cjoc/job/ctrl1");
  });
});
