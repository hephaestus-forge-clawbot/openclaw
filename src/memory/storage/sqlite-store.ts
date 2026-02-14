/**
 * SQLite database manager for Hephie's memory storage.
 *
 * Handles database lifecycle (open/close/migrate) and all CRUD + query
 * operations on memory_chunks. Vector and FTS operations are delegated
 * to specialised helpers but orchestrated here.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  MemoryChunk,
  MemoryChunkInput,
  MemoryChunkUpdate,
  MemoryStoreConfig,
  MemoryStats,
  MemoryTags,
  MemoryTier,
  PaginationOpts,
  SearchOpts,
  SearchResult,
  TagCategory,
  TagEmbedding,
  TagEmbeddingInput,
  TagSimilarityResult,
} from "./types.js";
// Re-use the project's sqlite-vec loader.
import { loadSqliteVecExtension } from "../sqlite-vec.js";
// Re-use the project's sqlite helper to get node:sqlite with the warning filter.
import { requireNodeSqlite } from "../sqlite.js";
import { flattenTags } from "../tags/extractor.js";
import {
  createChunksTable,
  createFtsTable,
  createVectorTable,
  runMigrations,
  FTS_TABLE,
  VEC_TABLE,
} from "./schema.js";

/** Default embedding dimensions. */
const DEFAULT_DIMS = 384;

/** Internal row shape from SQLite. */
interface ChunkRow {
  id: string;
  tier: string;
  content: string;
  summary: string | null;
  source: string | null;
  category: string | null;
  person: string | null;
  tags: string | null;
  confidence: number;
  created_at: number;
  updated_at: number;
  promoted_at: number | null;
  expires_at: number | null;
  metadata: string | null;
  relevance_horizon: number | null;
  horizon_reasoning: string | null;
  horizon_confidence: number | null;
  horizon_category: string | null;
}

/**
 * Parse tags from the database. Handles both legacy flat arrays and
 * structured MemoryTags JSON.
 */
function parseTags(raw: string | null): MemoryTags | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    // Legacy format: string[]
    if (Array.isArray(parsed)) {
      // Import dynamically would be circular, inline the conversion
      const result: MemoryTags = {
        concepts: [],
        specialized: [],
        people: [],
        places: [],
        projects: [],
      };
      // Put legacy flat tags into concepts as a fallback
      result.concepts = parsed;
      return result;
    }
    // New structured format
    if (typeof parsed === "object" && parsed !== null) {
      return {
        concepts: parsed.concepts ?? [],
        specialized: parsed.specialized ?? [],
        people: parsed.people ?? [],
        places: parsed.places ?? [],
        projects: parsed.projects ?? [],
      };
    }
  } catch {
    // Malformed JSON — ignore
  }
  return undefined;
}

function rowToChunk(row: ChunkRow): MemoryChunk {
  return {
    id: row.id,
    tier: row.tier as MemoryTier,
    content: row.content,
    summary: row.summary ?? undefined,
    source: row.source ?? undefined,
    category: row.category ?? undefined,
    person: row.person ?? undefined,
    tags: parseTags(row.tags),
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promotedAt: row.promoted_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    relevanceHorizon: row.relevance_horizon ?? undefined,
    horizonReasoning: row.horizon_reasoning ?? undefined,
    horizonConfidence: row.horizon_confidence ?? undefined,
    horizonCategory: row.horizon_category as MemoryChunk["horizonCategory"],
  };
}

/**
 * The main memory store. Wraps a single SQLite database with optional
 * vector (sqlite-vec) and FTS5 capabilities.
 */
export class MemoryStore {
  private db: DatabaseSync;
  private readonly dims: number;
  private vectorAvailable = false;
  private ftsAvailable = false;
  private closed = false;

  private constructor(db: DatabaseSync, dims: number) {
    this.db = db;
    this.dims = dims;
  }

  /**
   * Open (or create) a memory store.
   */
  static async open(config: MemoryStoreConfig): Promise<MemoryStore> {
    const dims = config.embeddingDimensions ?? DEFAULT_DIMS;
    const enableFts = config.enableFts !== false;
    const enableVector = config.enableVector !== false;

    // Ensure parent directory exists for file-based DBs
    if (config.dbPath !== ":memory:") {
      const dir = path.dirname(config.dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }

    const { DatabaseSync } = requireNodeSqlite();
    // allowExtension: true is required at construction time for sqlite-vec
    const db = new DatabaseSync(config.dbPath, {
      allowExtension: enableVector,
    } as ConstructorParameters<typeof DatabaseSync>[1]);

    // Enable WAL mode for better concurrency (skip for :memory: — no effect)
    if (config.dbPath !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL;");
    }
    db.exec("PRAGMA foreign_keys = ON;");

    // Create core tables
    createChunksTable(db);

    // Load sqlite-vec and create vector table
    const store = new MemoryStore(db, dims);

    if (enableVector) {
      const vecResult = await loadSqliteVecExtension({
        db,
        extensionPath: config.sqliteVecExtensionPath,
      });
      if (vecResult.ok) {
        const tableResult = createVectorTable(db, dims);
        store.vectorAvailable = tableResult.ok;
      }
    }

    // Create FTS table
    if (enableFts) {
      const ftsResult = createFtsTable(db);
      store.ftsAvailable = ftsResult.ok;
    }

    // Run migrations
    runMigrations(db);

    return store;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /**
   * Insert a new memory chunk. Returns the generated id.
   *
   * Optionally accepts a pre-computed embedding vector for vector search.
   */
  insert(input: MemoryChunkInput, embedding?: number[]): string {
    this.ensureOpen();
    const now = Date.now();
    const id = input.id ?? randomUUID();
    const chunk: MemoryChunk = {
      id,
      tier: input.tier,
      content: input.content,
      summary: input.summary,
      source: input.source,
      category: input.category,
      person: input.person,
      tags: input.tags,
      confidence: input.confidence ?? 1.0,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      promotedAt: input.promotedAt,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
    };

    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`
        INSERT INTO memory_chunks
          (id, tier, content, summary, source, category, person, tags,
           confidence, created_at, updated_at, promoted_at, expires_at, metadata,
           relevance_horizon, horizon_reasoning, horizon_confidence, horizon_category)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        chunk.id,
        chunk.tier,
        chunk.content,
        chunk.summary ?? null,
        chunk.source ?? null,
        chunk.category ?? null,
        chunk.person ?? null,
        chunk.tags ? JSON.stringify(chunk.tags) : null,
        chunk.confidence,
        chunk.createdAt,
        chunk.updatedAt,
        chunk.promotedAt ?? null,
        chunk.expiresAt ?? null,
        chunk.metadata ? JSON.stringify(chunk.metadata) : null,
        chunk.relevanceHorizon ?? null,
        chunk.horizonReasoning ?? null,
        chunk.horizonConfidence ?? null,
        chunk.horizonCategory ?? null,
      );

      // Insert into FTS — flatten structured tags for text search
      if (this.ftsAvailable) {
        const tagsText = chunk.tags ? flattenTags(chunk.tags).join(" ") : "";
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (chunk_id, content, summary, tags)
             VALUES (?, ?, ?, ?)`,
          )
          .run(chunk.id, chunk.content, chunk.summary ?? "", tagsText);
      }

      // Insert embedding
      if (this.vectorAvailable && embedding) {
        this.insertEmbedding(chunk.id, embedding);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return id;
  }

  /**
   * Update an existing chunk. Updates the FTS index as well.
   */
  update(id: string, updates: MemoryChunkUpdate, embedding?: number[]): void {
    this.ensureOpen();
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Memory chunk not found: ${id}`);
    }

    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    const map: Record<string, [string, (v: unknown) => string | number | null]> = {
      tier: ["tier", (v) => v as string],
      content: ["content", (v) => v as string],
      summary: ["summary", (v) => (v as string) ?? null],
      source: ["source", (v) => (v as string) ?? null],
      category: ["category", (v) => (v as string) ?? null],
      person: ["person", (v) => (v as string) ?? null],
      tags: ["tags", (v) => (v ? JSON.stringify(v) : null)],
      confidence: ["confidence", (v) => v as number],
      promotedAt: ["promoted_at", (v) => (v as number) ?? null],
      expiresAt: ["expires_at", (v) => (v as number) ?? null],
      metadata: ["metadata", (v) => (v ? JSON.stringify(v) : null)],
      relevanceHorizon: ["relevance_horizon", (v) => (v as number) ?? null],
      horizonReasoning: ["horizon_reasoning", (v) => (v as string) ?? null],
      horizonConfidence: ["horizon_confidence", (v) => (v as number) ?? null],
      horizonCategory: ["horizon_category", (v) => (v as string) ?? null],
    };

    for (const [key, [col, transform]] of Object.entries(map)) {
      if (key in updates) {
        fields.push(`${col} = ?`);
        values.push(transform((updates as Record<string, unknown>)[key]));
      }
    }

    // Always bump updated_at
    fields.push("updated_at = ?");
    const now = updates.updatedAt ?? Date.now();
    values.push(now);

    if (fields.length === 0) {
      return;
    }

    values.push(id);

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`UPDATE memory_chunks SET ${fields.join(", ")} WHERE id = ?`).run(...values);

      // Update FTS
      if (
        this.ftsAvailable &&
        ("content" in updates || "summary" in updates || "tags" in updates)
      ) {
        // Delete old FTS entry and re-insert
        this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE chunk_id = ?`).run(id);
        const merged = { ...existing, ...updates };
        const tagsText = merged.tags ? flattenTags(merged.tags).join(" ") : "";
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (chunk_id, content, summary, tags)
             VALUES (?, ?, ?, ?)`,
          )
          .run(id, merged.content, merged.summary ?? "", tagsText);
      }

      // Update embedding
      if (this.vectorAvailable && embedding) {
        this.deleteEmbedding(id);
        this.insertEmbedding(id, embedding);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Delete a memory chunk and its associated FTS/vector entries.
   */
  delete(id: string): void {
    this.ensureOpen();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM memory_chunks WHERE id = ?`).run(id);

      if (this.ftsAvailable) {
        this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE chunk_id = ?`).run(id);
      }
      if (this.vectorAvailable) {
        this.deleteEmbedding(id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Get a single chunk by id.
   */
  get(id: string): MemoryChunk | null {
    this.ensureOpen();
    const row = this.db.prepare(`SELECT * FROM memory_chunks WHERE id = ?`).get(id) as
      | ChunkRow
      | undefined;
    return row ? rowToChunk(row) : null;
  }

  // ── Search ────────────────────────────────────────────────────────────

  /**
   * Semantic (vector) search. Requires an embedding of the query.
   */
  semanticSearch(queryEmbedding: number[], opts: SearchOpts = {}): SearchResult[] {
    this.ensureOpen();
    if (!this.vectorAvailable) {
      return [];
    }

    const limit = opts.limit ?? 10;

    // Query sqlite-vec for nearest neighbours
    const vecRows = this.db
      .prepare(
        `SELECT chunk_id, distance
         FROM ${VEC_TABLE}
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(new Float32Array(queryEmbedding), limit * 2) as Array<{
      chunk_id: string;
      distance: number;
    }>;

    if (vecRows.length === 0) {
      return [];
    }

    const results: SearchResult[] = [];
    for (const vr of vecRows) {
      // Convert distance to similarity score (cosine distance → similarity)
      const score = 1 / (1 + vr.distance);
      if (opts.minScore !== undefined && score < opts.minScore) {
        continue;
      }

      const chunk = this.get(vr.chunk_id);
      if (!chunk) {
        continue;
      }
      if (!this.matchesFilters(chunk, opts)) {
        continue;
      }

      results.push({ chunk, score });
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  /**
   * Full-text search using FTS5.
   */
  fullTextSearch(query: string, opts: SearchOpts = {}): SearchResult[] {
    this.ensureOpen();
    if (!this.ftsAvailable) {
      return [];
    }

    const limit = opts.limit ?? 10;
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const ftsRows = this.db
      .prepare(
        `SELECT chunk_id, rank
         FROM ${FTS_TABLE}
         WHERE ${FTS_TABLE} MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit * 2) as Array<{ chunk_id: string; rank: number }>;

    const results: SearchResult[] = [];
    for (const fr of ftsRows) {
      const score = bm25RankToScore(fr.rank);
      if (opts.minScore !== undefined && score < opts.minScore) {
        continue;
      }

      const chunk = this.get(fr.chunk_id);
      if (!chunk) {
        continue;
      }
      if (!this.matchesFilters(chunk, opts)) {
        continue;
      }

      results.push({ chunk, score });
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  /**
   * Hybrid search combining semantic and full-text results.
   *
   * Uses reciprocal rank fusion (RRF) to merge the two ranked lists.
   */
  hybridSearch(
    query: string,
    queryEmbedding: number[],
    opts: SearchOpts = {},
    weights: { vector?: number; text?: number } = {},
  ): SearchResult[] {
    this.ensureOpen();
    const limit = opts.limit ?? 10;
    const vectorWeight = weights.vector ?? 0.7;
    const textWeight = weights.text ?? 0.3;

    // Fetch more candidates than needed so we can merge effectively
    const expandedOpts = { ...opts, limit: limit * 3, minScore: undefined };

    const vecResults = this.semanticSearch(queryEmbedding, expandedOpts);
    const ftsResults = this.fullTextSearch(query, expandedOpts);

    // Merge via weighted score combination
    const byId = new Map<string, { chunk: MemoryChunk; vecScore: number; ftsScore: number }>();

    for (const r of vecResults) {
      byId.set(r.chunk.id, { chunk: r.chunk, vecScore: r.score, ftsScore: 0 });
    }
    for (const r of ftsResults) {
      const existing = byId.get(r.chunk.id);
      if (existing) {
        existing.ftsScore = r.score;
      } else {
        byId.set(r.chunk.id, { chunk: r.chunk, vecScore: 0, ftsScore: r.score });
      }
    }

    const merged = Array.from(byId.values())
      .map((entry) => ({
        chunk: entry.chunk,
        score: vectorWeight * entry.vecScore + textWeight * entry.ftsScore,
      }))
      .filter((r) => (opts.minScore !== undefined ? r.score >= opts.minScore : true))
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit);

    return merged;
  }

  /**
   * Tag-boosted hybrid search.
   *
   * Performs hybrid search, then boosts results whose tags match
   * the specified boost tags. Useful when a query mentions a project,
   * person, or domain — matching chunks get a score boost.
   *
   * @param boostTags - Partial MemoryTags; matching chunks get boosted.
   * @param boostFactor - Multiplier for matching chunks (default 1.3).
   */
  tagBoostedSearch(
    query: string,
    queryEmbedding: number[],
    boostTags: Partial<MemoryTags>,
    opts: SearchOpts = {},
    boostFactor = 1.3,
  ): SearchResult[] {
    const results = this.hybridSearch(query, queryEmbedding, opts);

    // Apply tag boost
    for (const result of results) {
      if (this.chunkMatchesAnyTag(result.chunk, boostTags)) {
        result.score *= boostFactor;
      }
    }

    // Re-sort after boosting
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, opts.limit ?? 10);
  }

  /**
   * Check if a chunk matches any tag in the given partial tag set.
   */
  private chunkMatchesAnyTag(chunk: MemoryChunk, boostTags: Partial<MemoryTags>): boolean {
    if (!chunk.tags) {
      return false;
    }
    for (const [dim, values] of Object.entries(boostTags)) {
      if (!values || values.length === 0) {
        continue;
      }
      const chunkValues = chunk.tags[dim as keyof MemoryTags] ?? [];
      if (values.some((v: string) => chunkValues.includes(v))) {
        return true;
      }
    }
    return false;
  }

  // ── Tier operations ───────────────────────────────────────────────────

  /**
   * Get all chunks in a given tier with optional pagination.
   */
  getByTier(tier: MemoryTier, opts: PaginationOpts = {}): MemoryChunk[] {
    this.ensureOpen();
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const orderBy = opts.orderBy ?? "created_at";
    const order = opts.order ?? "desc";

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_chunks
         WHERE tier = ?
         ORDER BY ${orderBy} ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(tier, limit, offset) as unknown as ChunkRow[];

    return rows.map(rowToChunk);
  }

  /**
   * Promote a chunk to a higher tier.
   */
  promote(id: string, toTier: MemoryTier): void {
    this.ensureOpen();
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE memory_chunks
         SET tier = ?, promoted_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(toTier, now, now, id);
    if ((result as { changes: number }).changes === 0) {
      throw new Error(`Memory chunk not found: ${id}`);
    }
  }

  /**
   * Decay (demote or delete) chunks older than a given date from one tier.
   *
   * If `toTier` is provided, chunks are moved to that tier.
   * If `toTier` is null, expired chunks are deleted.
   *
   * Returns the number of affected chunks.
   */
  decay(olderThan: Date, fromTier: MemoryTier, toTier: MemoryTier | null): number {
    this.ensureOpen();
    const cutoff = olderThan.getTime();
    const now = Date.now();

    if (toTier === null) {
      // Delete expired chunks
      const rows = this.db
        .prepare(`SELECT id FROM memory_chunks WHERE tier = ? AND updated_at < ?`)
        .all(fromTier, cutoff) as Array<{ id: string }>;

      for (const row of rows) {
        this.delete(row.id);
      }
      return rows.length;
    }

    // Demote to a lower tier
    const result = this.db
      .prepare(
        `UPDATE memory_chunks
         SET tier = ?, updated_at = ?
         WHERE tier = ? AND updated_at < ?`,
      )
      .run(toTier, now, fromTier, cutoff);
    return (result as { changes: number }).changes;
  }

  /**
   * Delete expired chunks (where expires_at < now).
   * Returns number of deleted chunks.
   */
  deleteExpired(): number {
    this.ensureOpen();
    const now = Date.now();
    const rows = this.db
      .prepare(`SELECT id FROM memory_chunks WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .all(now) as Array<{ id: string }>;

    for (const row of rows) {
      this.delete(row.id);
    }
    return rows.length;
  }

  // ── Person-scoped queries ─────────────────────────────────────────────

  /**
   * Get all chunks associated with a specific person.
   */
  getByPerson(person: string, opts: PaginationOpts = {}): MemoryChunk[] {
    this.ensureOpen();
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const orderBy = opts.orderBy ?? "created_at";
    const order = opts.order ?? "desc";

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_chunks
         WHERE person = ?
         ORDER BY ${orderBy} ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(person, limit, offset) as unknown as ChunkRow[];

    return rows.map(rowToChunk);
  }

  // ── Maintenance ───────────────────────────────────────────────────────

  /**
   * Run VACUUM to reclaim space.
   */
  vacuum(): void {
    this.ensureOpen();
    this.db.exec("VACUUM;");
  }

  /**
   * Get aggregate statistics.
   */
  stats(): MemoryStats {
    this.ensureOpen();

    const total = this.db.prepare(`SELECT COUNT(*) as count FROM memory_chunks`).get() as {
      count: number;
    };

    const tierRows = this.db
      .prepare(`SELECT tier, COUNT(*) as count FROM memory_chunks GROUP BY tier`)
      .all() as Array<{ tier: string; count: number }>;

    const categoryRows = this.db
      .prepare(
        `SELECT COALESCE(category, 'uncategorized') as category, COUNT(*) as count
         FROM memory_chunks GROUP BY category`,
      )
      .all() as Array<{ category: string; count: number }>;

    const personRows = this.db
      .prepare(
        `SELECT person, COUNT(*) as count
         FROM memory_chunks WHERE person IS NOT NULL GROUP BY person`,
      )
      .all() as Array<{ person: string; count: number }>;

    const oldest = this.db.prepare(`SELECT MIN(created_at) as ts FROM memory_chunks`).get() as {
      ts: number | null;
    };

    const newest = this.db.prepare(`SELECT MAX(created_at) as ts FROM memory_chunks`).get() as {
      ts: number | null;
    };

    // DB size — for :memory: databases, use page_count * page_size
    const pageCount = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    const dbSizeBytes = pageCount.page_count * pageSize.page_size;

    const byTier: Record<MemoryTier, number> = {
      working: 0,
      short_term: 0,
      long_term: 0,
      episodic: 0,
    };
    for (const row of tierRows) {
      byTier[row.tier as MemoryTier] = row.count;
    }

    const byCategory: Record<string, number> = {};
    for (const row of categoryRows) {
      byCategory[row.category] = row.count;
    }

    const byPerson: Record<string, number> = {};
    for (const row of personRows) {
      byPerson[row.person] = row.count;
    }

    return {
      totalChunks: total.count,
      byTier,
      byCategory,
      byPerson,
      oldestChunk: oldest.ts,
      newestChunk: newest.ts,
      dbSizeBytes,
    };
  }

  /**
   * Check if vector search is available.
   */
  isVectorAvailable(): boolean {
    return this.vectorAvailable;
  }

  /**
   * Check if FTS is available.
   */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  // ── Tag Embedding Operations ─────────────────────────────────────────

  /**
   * Store or update a tag embedding for semantic similarity search.
   */
  upsertTagEmbedding(input: TagEmbeddingInput): void {
    this.ensureOpen();
    const now = Date.now();
    const created = input.createdAt ?? now;
    const updated = input.updatedAt ?? now;

    // Serialize embedding to BLOB
    const blob = Buffer.from(input.embedding.buffer);

    this.db
      .prepare(
        `INSERT INTO tag_embeddings (tag, category, embedding, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tag, category) DO UPDATE SET
           embedding = excluded.embedding,
           updated_at = excluded.updated_at`,
      )
      .run(input.tag, input.category, blob, created, updated);
  }

  /**
   * Retrieve a specific tag embedding.
   */
  getTagEmbedding(tag: string, category: TagCategory): TagEmbedding | null {
    this.ensureOpen();
    const row = this.db
      .prepare(
        `SELECT tag, category, embedding, created_at, updated_at
         FROM tag_embeddings
         WHERE tag = ? AND category = ?`,
      )
      .get(tag, category) as
      | {
          tag: string;
          category: string;
          embedding: Buffer;
          created_at: number;
          updated_at: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      tag: row.tag,
      category: row.category as TagCategory,
      embedding: new Float32Array(row.embedding.buffer),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find semantically similar tags using cosine similarity.
   *
   * @param queryEmbedding - The query vector (e.g., embedding of "ML")
   * @param category - Optional category filter (e.g., only search "concepts")
   * @param minSimilarity - Minimum cosine similarity threshold (default 0.7)
   * @param limit - Maximum results to return (default 10)
   */
  findSimilarTags(
    queryEmbedding: Float32Array,
    category?: TagCategory,
    minSimilarity = 0.7,
    limit = 10,
  ): TagSimilarityResult[] {
    this.ensureOpen();

    let query = `SELECT tag, category, embedding FROM tag_embeddings`;
    const params: (string | number)[] = [];

    if (category) {
      query += ` WHERE category = ?`;
      params.push(category);
    }

    const rows = this.db.prepare(query).all(...params) as Array<{
      tag: string;
      category: string;
      embedding: Buffer;
    }>;

    // Compute cosine similarity for each tag
    const results: TagSimilarityResult[] = [];
    for (const row of rows) {
      const tagEmbedding = new Float32Array(row.embedding.buffer);
      const similarity = cosineSimilarity(queryEmbedding, tagEmbedding);

      if (similarity >= minSimilarity) {
        results.push({
          tag: row.tag,
          category: row.category as TagCategory,
          similarity,
        });
      }
    }

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, limit);
  }

  /**
   * Get all unique tags for a specific category.
   */
  getAllTags(category?: TagCategory): Array<{ tag: string; category: TagCategory }> {
    this.ensureOpen();

    let query = `SELECT DISTINCT tag, category FROM tag_embeddings`;
    const params: string[] = [];

    if (category) {
      query += ` WHERE category = ?`;
      params.push(category);
    }

    query += ` ORDER BY tag ASC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      tag: string;
      category: string;
    }>;

    return rows.map((r) => ({
      tag: r.tag,
      category: r.category as TagCategory,
    }));
  }

  /**
   * Delete a tag embedding.
   */
  deleteTagEmbedding(tag: string, category: TagCategory): void {
    this.ensureOpen();
    this.db.prepare(`DELETE FROM tag_embeddings WHERE tag = ? AND category = ?`).run(tag, category);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("MemoryStore is closed");
    }
  }

  private insertEmbedding(chunkId: string, embedding: number[]): void {
    this.db
      .prepare(`INSERT INTO ${VEC_TABLE} (chunk_id, embedding) VALUES (?, ?)`)
      .run(chunkId, new Float32Array(embedding));
  }

  private deleteEmbedding(chunkId: string): void {
    this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE chunk_id = ?`).run(chunkId);
  }

  private matchesFilters(chunk: MemoryChunk, opts: SearchOpts): boolean {
    if (opts.tier && chunk.tier !== opts.tier) {
      return false;
    }
    if (opts.person && chunk.person !== opts.person) {
      return false;
    }
    if (opts.category && chunk.category !== opts.category) {
      return false;
    }
    // Legacy flat tag filter (any match)
    if (opts.tags && opts.tags.length > 0) {
      const chunkFlat = chunk.tags ? flattenTags(chunk.tags) : [];
      if (!opts.tags.some((t) => chunkFlat.includes(t))) {
        return false;
      }
    }
    // Structured tag filter (intersection — ALL specified dimensions must match)
    if (opts.structuredTags) {
      if (!chunk.tags) {
        return false;
      }
      for (const [dim, requiredValues] of Object.entries(opts.structuredTags)) {
        if (!requiredValues || requiredValues.length === 0) {
          continue;
        }
        const chunkValues = chunk.tags[dim as keyof MemoryTags] ?? [];
        // ALL required values must be present in this dimension
        if (!requiredValues.every((v: string) => chunkValues.includes(v))) {
          return false;
        }
      }
    }
    return true;
  }
}

// ── Standalone helpers ────────────────────────────────────────────────────

/**
 * Build an FTS5 query from raw user text.
 * Returns null if no valid tokens.
 */
function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  // Use OR for recall, let ranking handle precision
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Convert BM25 rank (negative = better in FTS5) to a 0–1 score.
 */
function bm25RankToScore(rank: number): number {
  // FTS5 rank is negative (more negative = more relevant)
  const normalized = Number.isFinite(rank) ? Math.abs(rank) : 0;
  return normalized / (1 + normalized);
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (typically 0-1 for normalized embeddings).
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}
