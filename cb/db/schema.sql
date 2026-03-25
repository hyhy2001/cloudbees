-- CloudBees CLI Database Schema
-- SQLite 3.7+ compatible
-- NOTE: No WITHOUT ROWID, STRICT, RETURNING, WAL mode

CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    server_url TEXT    NOT NULL,
    username   TEXT    NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);



CREATE TABLE IF NOT EXISTS cache (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
