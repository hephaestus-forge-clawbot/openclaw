/**
 * Schema definitions and migrations for the Hephie memory storage.
 *
 * Uses Node's built-in `node:sqlite` DatabaseSync.
 */

import type { DatabaseSync } from "node:sqlite";

/** Current schema version. Bump when adding migrations. */
export const SCHEMA_VERSION = 2;

/** Name of the vector virtual table. */
export const VEC_TABLE = "memory_embeddings";

/** Name of the FTS virtual table. */
export const FTS_TABLE = "memory_fts";

/**
 * Create the core `memory_chunks` table if it doesn't exist.
 */
export function createChunksTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL CHECK(tier IN ('working', 'short_term', 'long_term', 'episodic')),
      content TEXT NOT NULL,
      summary TEXT,
      source TEXT,
      category TEXT,
      person TEXT,
      tags TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      promoted_at INTEGER,
      expires_at INTEGER,
      metadata TEXT,
      relevance_horizon INTEGER,
      horizon_reasoning TEXT,
      horizon_confidence REAL,
      horizon_category TEXT
    );
  `);

  // Indexes for common query patterns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mc_tier ON memory_chunks(tier);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mc_person ON memory_chunks(person);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mc_category ON memory_chunks(category);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mc_created_at ON memory_chunks(created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mc_updated_at ON memory_chunks(updated_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mc_expires_at ON memory_chunks(expires_at);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mc_relevance_horizon ON memory_chunks(relevance_horizon);`,
  );
}

/**
 * Create the `memory_embeddings` vec0 virtual table.
 * Requires sqlite-vec extension to be loaded.
 *
 * @returns true if created successfully, false if vec0 isn't available.
 */
export function createVectorTable(
  db: DatabaseSync,
  dimensions: number,
): { ok: boolean; error?: string } {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
        chunk_id TEXT NOT NULL,
        embedding FLOAT[${dimensions}]
      );
    `);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Create the FTS5 virtual table for full-text search.
 *
 * Uses a content-sync approach: the FTS table is kept in sync manually
 * (not using content= because that complicates deletes/updates).
 */
export function createFtsTable(db: DatabaseSync): { ok: boolean; error?: string } {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
        chunk_id UNINDEXED,
        content,
        summary,
        tags
      );
    `);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Create the schema version tracking table and return current version.
 */
export function getSchemaVersion(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_schema_version (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL
    );
  `);
  const row = db.prepare(`SELECT version FROM memory_schema_version WHERE id = 1`).get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Set the schema version.
 */
export function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec(`
    INSERT INTO memory_schema_version (id, version) VALUES (1, ${version})
    ON CONFLICT(id) DO UPDATE SET version = ${version};
  `);
}

/**
 * Run all pending migrations up to SCHEMA_VERSION.
 */
export function runMigrations(db: DatabaseSync): void {
  const current = getSchemaVersion(db);
  if (current >= SCHEMA_VERSION) {
    return;
  }

  // Migration 0 → 1: initial schema (tables created above)

  // Migration 1 → 2: add horizon columns for relevance prediction
  if (current < 2) {
    // Add horizon columns (these may already exist on fresh DBs created with v2 schema)
    const columns = db.prepare(`PRAGMA table_info(memory_chunks)`).all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has("relevance_horizon")) {
      db.exec(`ALTER TABLE memory_chunks ADD COLUMN relevance_horizon INTEGER;`);
    }
    if (!columnNames.has("horizon_reasoning")) {
      db.exec(`ALTER TABLE memory_chunks ADD COLUMN horizon_reasoning TEXT;`);
    }
    if (!columnNames.has("horizon_confidence")) {
      db.exec(`ALTER TABLE memory_chunks ADD COLUMN horizon_confidence REAL;`);
    }
    if (!columnNames.has("horizon_category")) {
      db.exec(`ALTER TABLE memory_chunks ADD COLUMN horizon_category TEXT;`);
    }

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_mc_relevance_horizon ON memory_chunks(relevance_horizon);`,
    );
  }

  setSchemaVersion(db, SCHEMA_VERSION);
}
