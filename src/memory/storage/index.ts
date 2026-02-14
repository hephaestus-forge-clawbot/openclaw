/**
 * Hephie Memory Storage — Public API
 *
 * A self-contained 4-tier memory storage layer built on SQLite with
 * optional sqlite-vec vector search and FTS5 full-text search.
 *
 * Usage:
 *   import { MemoryStore } from "./memory/storage/index.js";
 *
 *   const store = await MemoryStore.open({ dbPath: "/path/to/memory.db" });
 *   const id = store.insert({ tier: "short_term", content: "..." });
 *   const results = store.fullTextSearch("keyword");
 *   store.close();
 */

export { MemoryStore } from "./sqlite-store.js";

export type {
  HorizonCategory,
  MemoryChunk,
  MemoryChunkInput,
  MemoryChunkUpdate,
  MemoryCategory,
  MemoryStoreConfig,
  MemoryStats,
  MemoryTags,
  MemoryTier,
  PaginationOpts,
  SearchOpts,
  SearchResult,
} from "./types.js";

export { SCHEMA_VERSION } from "./schema.js";
