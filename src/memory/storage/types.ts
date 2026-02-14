/**
 * Types for the Hephie 4-tier memory storage system.
 *
 * This module is self-contained — no imports from the rest of the codebase.
 */

/** The four tiers of Hephie's memory hierarchy. */
export type MemoryTier = "working" | "short_term" | "long_term" | "episodic";

/** Categories for classifying memory chunks. */
export type MemoryCategory =
  | "person"
  | "preference"
  | "decision"
  | "lesson"
  | "fact"
  | "event"
  | "emotion"
  | "project"
  | "custom";

/** A single memory chunk — the atomic unit of Hephie's memory. */
export interface MemoryChunk {
  /** Unique identifier (UUID v4). */
  id: string;

  /** Which tier this memory lives in. */
  tier: MemoryTier;

  /** The full text content. */
  content: string;

  /** Optional condensed summary for long-term storage. */
  summary?: string;

  /** Origin context: session key, channel name, etc. */
  source?: string;

  /** Classification category. */
  category?: string;

  /** For per-person compartmentalization. */
  person?: string;

  /** Searchable tags. */
  tags?: string[];

  /** Confidence score 0–1 (default 1.0). */
  confidence: number;

  /** Unix timestamp (ms) when created. */
  createdAt: number;

  /** Unix timestamp (ms) when last updated. */
  updatedAt: number;

  /** Unix timestamp (ms) when promoted from a lower tier. */
  promotedAt?: number;

  /** Unix timestamp (ms) after which this chunk expires (for auto-decay). */
  expiresAt?: number;

  /** Extensible JSON metadata. */
  metadata?: Record<string, unknown>;
}

/** Input for creating a new memory chunk. id/createdAt/updatedAt are auto-set if omitted. */
export type MemoryChunkInput = Omit<MemoryChunk, "id" | "createdAt" | "updatedAt" | "confidence"> &
  Partial<Pick<MemoryChunk, "id" | "createdAt" | "updatedAt" | "confidence">>;

/** Fields that can be updated on an existing chunk. */
export type MemoryChunkUpdate = Partial<Omit<MemoryChunk, "id" | "createdAt">>;

/** Options for search operations. */
export interface SearchOpts {
  /** Maximum results to return (default 10). */
  limit?: number;

  /** Minimum score threshold (0–1). */
  minScore?: number;

  /** Filter to a specific tier. */
  tier?: MemoryTier;

  /** Filter to a specific person. */
  person?: string;

  /** Filter to a specific category. */
  category?: string;

  /** Filter by tags (any match). */
  tags?: string[];
}

/** A search result with relevance score. */
export interface SearchResult {
  chunk: MemoryChunk;
  score: number;
}

/** Options for paginated list queries. */
export interface PaginationOpts {
  limit?: number;
  offset?: number;
  orderBy?: "created_at" | "updated_at" | "confidence";
  order?: "asc" | "desc";
}

/** Aggregate stats for the memory store. */
export interface MemoryStats {
  totalChunks: number;
  byTier: Record<MemoryTier, number>;
  byCategory: Record<string, number>;
  byPerson: Record<string, number>;
  oldestChunk: number | null;
  newestChunk: number | null;
  dbSizeBytes: number;
}

/** Configuration for the memory store. */
export interface MemoryStoreConfig {
  /** Path to the SQLite database file. Use ":memory:" for in-memory. */
  dbPath: string;

  /** Embedding vector dimensions (default 384). */
  embeddingDimensions?: number;

  /** Whether to enable FTS (default true). */
  enableFts?: boolean;

  /** Whether to enable vector search (default true). */
  enableVector?: boolean;

  /** Optional path to a custom sqlite-vec extension binary. */
  sqliteVecExtensionPath?: string;
}
