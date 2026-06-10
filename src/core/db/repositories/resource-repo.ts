/**
 * User-resource tracking repository.
 * Behavioural 1:1 port of legacy/cb/db/repositories/resource_repo.py
 */

import { getConnection } from "../connection";

interface ResourceNameRow {
  name: string;
}

/**
 * Insert or replace a tracked resource record.
 * Mirrors Python track_resource().
 */
export function trackResource(
  resourceType: string,
  name: string,
  profileName: string,
  controllerName = "",
  dbPath?: string
): void {
  const now = Math.floor(Date.now() / 1000);
  const db = getConnection(dbPath);
  try {
    db.run(
      `INSERT OR REPLACE INTO user_resources
         (resource_type, name, profile_name, controller_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      [resourceType, name, profileName, controllerName, now]
    );
  } finally {
    db.close();
  }
}

/**
 * Remove a tracked resource record.
 * Mirrors Python untrack_resource().
 */
export function untrackResource(
  resourceType: string,
  name: string,
  profileName: string,
  controllerName = "",
  dbPath?: string
): void {
  const db = getConnection(dbPath);
  try {
    db.run(
      `DELETE FROM user_resources
       WHERE resource_type = ? AND name = ? AND profile_name = ? AND controller_name = ?`,
      [resourceType, name, profileName, controllerName]
    );
  } finally {
    db.close();
  }
}

/**
 * Return names of all tracked resources matching the given type, profile, and
 * optional controller.
 * Mirrors Python get_tracked_resources().
 */
export function getTrackedResources(
  resourceType: string,
  profileName: string,
  controllerName = "",
  dbPath?: string
): string[] {
  const db = getConnection(dbPath);
  try {
    const rows = db.query<ResourceNameRow, [string, string, string]>(
      `SELECT name FROM user_resources
       WHERE resource_type = ? AND profile_name = ? AND controller_name = ?`
    ).all(resourceType, profileName, controllerName);
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}
