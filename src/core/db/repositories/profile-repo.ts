/**
 * Profile repository — SQLite3 CRUD.
 * Behavioural 1:1 port of legacy/cb/db/repositories/profile_repo.py
 */

import { getConnection } from "../connection";
import { NotFoundError } from "../../api/errors";

export interface Profile {
  id: number;
  name: string;
  serverUrl: string;
  username: string;
  isDefault: boolean;
  createdAt: number;
}

// Raw row shape returned by bun:sqlite
interface ProfileRow {
  id: number;
  name: string;
  server_url: string;
  username: string;
  is_default: number;
  created_at: number;
}

function rowToProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.server_url,
    username: row.username,
    isDefault: row.is_default !== 0,
    createdAt: row.created_at,
  };
}

/**
 * Insert or update a profile. If is_default is true, clears is_default on all
 * other profiles first. Preserves the existing row id on update so any FK
 * relationships stay valid. Returns the saved profile.
 * Mirrors Python save_profile().
 */
export function saveProfile(
  name: string,
  serverUrl: string,
  username: string,
  isDefault = false,
  dbPath?: string
): Profile {
  const now = Math.floor(Date.now() / 1000);
  const db = getConnection(dbPath);
  try {
    if (isDefault) {
      db.run("UPDATE profiles SET is_default = 0");
    }

    // Try UPDATE first — preserves id so token FK stays valid
    const updated = db.run(
      `UPDATE profiles SET server_url = ?, username = ?, is_default = ? WHERE name = ?`,
      [serverUrl.replace(/\/+$/, ""), username, isDefault ? 1 : 0, name]
    );

    if (updated.changes === 0) {
      // New profile — INSERT
      db.run(
        `INSERT INTO profiles (name, server_url, username, is_default, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [name, serverUrl.replace(/\/+$/, ""), username, isDefault ? 1 : 0, now]
      );
    }
  } finally {
    db.close();
  }

  // getProfile opens its own connection — matches Python behaviour
  return getProfile(name, dbPath);
}

/**
 * Fetch a single profile by name. Throws if not found.
 * Mirrors Python get_profile().
 */
export function getProfile(name: string, dbPath?: string): Profile {
  const db = getConnection(dbPath);
  try {
    const row = db.query<ProfileRow, [string]>(
      "SELECT * FROM profiles WHERE name = ?"
    ).get(name);
    if (row === null) {
      throw new NotFoundError(`Profile '${name}' not found.`);
    }
    return rowToProfile(row);
  } finally {
    db.close();
  }
}

/**
 * Return the default profile, falling back to the oldest profile if none is
 * marked default. Returns null if no profiles exist.
 * Mirrors Python get_default_profile().
 */
export function getDefaultProfile(dbPath?: string): Profile | null {
  const db = getConnection(dbPath);
  try {
    let row = db.query<ProfileRow, []>(
      "SELECT * FROM profiles WHERE is_default = 1 LIMIT 1"
    ).get();

    if (row === null) {
      // Fall back to the first profile created
      row = db.query<ProfileRow, []>(
        "SELECT * FROM profiles ORDER BY created_at LIMIT 1"
      ).get();
    }

    return row !== null ? rowToProfile(row) : null;
  } finally {
    db.close();
  }
}

/**
 * Return all profiles ordered by default-first then creation time.
 * Mirrors Python list_profiles().
 */
export function listProfiles(dbPath?: string): Profile[] {
  const db = getConnection(dbPath);
  try {
    const rows = db.query<ProfileRow, []>(
      "SELECT * FROM profiles ORDER BY is_default DESC, created_at"
    ).all();
    return rows.map(rowToProfile);
  } finally {
    db.close();
  }
}

/**
 * Delete a profile by name.
 * Mirrors Python delete_profile().
 */
export function deleteProfile(name: string, dbPath?: string): void {
  const db = getConnection(dbPath);
  try {
    db.run("DELETE FROM profiles WHERE name = ?", [name]);
  } finally {
    db.close();
  }
}
