/**
 * Settings repository — simple key/value store in SQLite.
 * Behavioural 1:1 port of legacy/cb/db/repositories/settings_repo.py
 */

import { getConnection, initDb } from "../connection";

interface SettingsRow {
  value: string;
}

/**
 * Return the value for a settings key, or null if not found.
 * Auto-initialises the DB if the settings table is missing.
 * Mirrors Python get_setting().
 */
export function getSetting(key: string, dbPath?: string): string | null {
  const db = getConnection(dbPath);
  try {
    const row = db.query<SettingsRow, [string]>(
      "SELECT value FROM settings WHERE key = ?"
    ).get(key);
    return row !== null ? row.value : null;
  } catch (e) {
    if (String(e).includes("no such table")) {
      initDb(dbPath);
      return getSetting(key, dbPath);
    }
    throw e;
  } finally {
    db.close();
  }
}

/**
 * Insert or replace a setting.
 * Mirrors Python set_setting().
 */
export function setSetting(key: string, value: string, dbPath?: string): void {
  const db = getConnection(dbPath);
  try {
    db.run(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      [key, value]
    );
  } finally {
    db.close();
  }
}

/**
 * Delete a setting by key.
 * Mirrors Python delete_setting().
 */
export function deleteSetting(key: string, dbPath?: string): void {
  const db = getConnection(dbPath);
  try {
    db.run("DELETE FROM settings WHERE key = ?", [key]);
  } finally {
    db.close();
  }
}
