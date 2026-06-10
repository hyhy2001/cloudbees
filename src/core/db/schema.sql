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

CREATE TABLE IF NOT EXISTS jobs (
    name         TEXT PRIMARY KEY,
    job_type     TEXT,
    color        TEXT,
    build_number INTEGER,
    description  TEXT,
    last_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
    name          TEXT PRIMARY KEY,
    offline       INTEGER NOT NULL DEFAULT 0,
    num_executors INTEGER,
    labels        TEXT,
    description   TEXT,
    last_updated  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipelines (
    name         TEXT PRIMARY KEY,
    status       TEXT,
    branch       TEXT,
    description  TEXT,
    last_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_resources (
    resource_type   TEXT NOT NULL,
    name            TEXT NOT NULL,
    profile_name    TEXT NOT NULL,
    controller_name TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (resource_type, name, profile_name, controller_name)
);
