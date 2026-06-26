import { getConnection } from "../connection";

export interface AskHistoryEntry {
  id: number;
  query: string;
  answer: string;
  created_at: number;
}

export function saveAskHistory(query: string, answer: string, dbPath?: string): void {
  const db = getConnection(dbPath);
  db.run("INSERT INTO ask_history (query, answer, created_at) VALUES (?, ?, ?)", [
    query, answer, Date.now(),
  ]);
}

export function getAskHistory(limit = 20, dbPath?: string): AskHistoryEntry[] {
  const db = getConnection(dbPath);
  return db.query<AskHistoryEntry, [number]>(
    "SELECT id, query, answer, created_at FROM ask_history ORDER BY created_at DESC LIMIT ?",
  ).all(limit);
}

export function clearAskHistory(dbPath?: string): void {
  const db = getConnection(dbPath);
  db.run("DELETE FROM ask_history");
}
