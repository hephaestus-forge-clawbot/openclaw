/**
 * Hephie Memory System Facade
 *
 * Top-level orchestrator for the 4-tier memory architecture.
 * Provides convenience methods for remember/recall/forget, tier management,
 * context injection, and lifecycle operations.
 *
 * Usage:
 *   const system = await MemorySystem.create({ dbPath: "memory.db" });
 *   const id = await system.remember("Father prefers dark mode", { category: "preference" });
 *   const chunks = await system.recall("dark mode");
 *   const ctx = await system.assembleContext({ currentMessage: "what theme?" });
 *   await system.close();
 */

import type { EmbeddingProvider, EmbeddingConfig } from "./embeddings/types.js";
import type {
  MemoryChunk,
  MemoryChunkInput,
  MemoryTier,
  SearchOpts,
  SearchResult,
  MemoryStats,
  MemoryStoreConfig,
} from "./storage/types.js";
import {
  ContextInjector,
  type QuerySignals,
  type AssembledContext,
  type ContextBudget,
} from "./context-injector.js";
import { createEmbeddingProvider } from "./embeddings/index.js";
import { MemoryMaintenance, type MaintenanceConfig } from "./maintenance.js";
import { MemoryStore } from "./storage/sqlite-store.js";

// ── Options types ─────────────────────────────────────────────────────────

/** Options for the `remember()` convenience method. */
export interface RememberOpts {
  /** Which tier to store in (default: "short_term"). */
  tier?: MemoryTier;
  /** Semantic category. */
  category?: string;
  /** Optional summary (auto-truncated from content if not provided). */
  summary?: string;
  /** Per-person compartmentalization. */
  person?: string;
  /** Searchable tags. */
  tags?: string[];
  /** Origin context. */
  source?: string;
  /** Initial confidence (default: 0.7 for session, 1.0 for manual). */
  confidence?: number;
  /** Expiry timestamp (ms). Auto-set for short_term if not provided. */
  expiresAt?: number;
  /** Extensible metadata. */
  metadata?: Record<string, unknown>;
}

/** Options for the `recall()` convenience method. */
export interface RecallOpts extends SearchOpts {
  /** Use semantic search (requires embedding provider). Default: true. */
  semantic?: boolean;
  /** Use full-text search. Default: true. */
  fullText?: boolean;
}

/** Full config for creating a MemorySystem. */
export interface MemorySystemConfig {
  /** SQLite store config. */
  store: MemoryStoreConfig;
  /** Embedding provider config (optional — skips embeddings if not provided). */
  embedding?: EmbeddingConfig;
  /** Context injection budget (optional — uses defaults). */
  contextBudget?: Partial<ContextBudget>;
  /** Maintenance config (optional — uses defaults). */
  maintenance?: Partial<MaintenanceConfig>;
}

// ── Default retention ─────────────────────────────────────────────────────

/** Default short-term retention: 7 days in ms. */
const SHORT_TERM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Auto-generate a summary from content (first ~150 chars). */
function autoSummary(content: string, maxLen = 150): string {
  if (content.length <= maxLen) {
    return content;
  }
  const cut = content.lastIndexOf(" ", maxLen);
  return content.slice(0, cut > 0 ? cut : maxLen) + "…";
}

// ── MemorySystem ──────────────────────────────────────────────────────────

export class MemorySystem {
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingProvider | null;
  private readonly injector: ContextInjector;
  private readonly maintenance: MemoryMaintenance;
  private closed = false;

  private constructor(
    store: MemoryStore,
    embeddings: EmbeddingProvider | null,
    injector: ContextInjector,
    maintenance: MemoryMaintenance,
  ) {
    this.store = store;
    this.embeddings = embeddings;
    this.injector = injector;
    this.maintenance = maintenance;
  }

  /**
   * Create and initialize a MemorySystem.
   */
  static async create(config: MemorySystemConfig): Promise<MemorySystem> {
    const store = await MemoryStore.open(config.store);

    let embeddings: EmbeddingProvider | null = null;
    if (config.embedding !== undefined) {
      try {
        embeddings = await createEmbeddingProvider(config.embedding);
      } catch {
        // Embeddings are optional — degrade gracefully
        console.warn("[hephie:memory] Embedding provider unavailable — semantic search disabled");
      }
    }

    const injector = new ContextInjector(store, embeddings, config.contextBudget);
    const maintenance = new MemoryMaintenance(store, config.maintenance);

    return new MemorySystem(store, embeddings, injector, maintenance);
  }

  // ── Convenience Methods ───────────────────────────────────────────────

  /**
   * Store a new memory. Returns the chunk id.
   *
   * Handles: chunk creation, optional async embedding, auto-summary, auto-expiry.
   */
  async remember(content: string, opts: RememberOpts = {}): Promise<string> {
    this.ensureOpen();

    const tier = opts.tier ?? "short_term";
    const now = Date.now();

    // Auto-set expiry for short_term chunks
    let expiresAt = opts.expiresAt;
    if (expiresAt === undefined && tier === "short_term") {
      expiresAt = now + SHORT_TERM_RETENTION_MS;
    }

    const input: MemoryChunkInput = {
      tier,
      content,
      summary: opts.summary ?? autoSummary(content),
      category: opts.category,
      person: opts.person,
      tags: opts.tags,
      source: opts.source ?? "session",
      confidence: opts.confidence ?? 0.7,
      expiresAt,
      metadata: opts.metadata,
    };

    // Compute embedding if provider available
    let embedding: number[] | undefined;
    if (this.embeddings) {
      try {
        embedding = await this.embeddings.embed(content);
      } catch {
        // Non-fatal — store without embedding
      }
    }

    return this.store.insert(input, embedding);
  }

  /**
   * Recall memories relevant to a query string.
   * Uses hybrid search by default (semantic + FTS), falls back gracefully.
   */
  async recall(query: string, opts: RecallOpts = {}): Promise<MemoryChunk[]> {
    this.ensureOpen();

    const useSemantic = (opts.semantic ?? true) && this.embeddings !== null;
    const useFullText = opts.fullText ?? true;
    const searchOpts: SearchOpts = {
      limit: opts.limit ?? 10,
      minScore: opts.minScore,
      tier: opts.tier,
      person: opts.person,
      category: opts.category,
      tags: opts.tags,
    };

    let results: SearchResult[];

    if (useSemantic && useFullText) {
      const queryEmb = await this.embeddings.embed(query);
      results = this.store.hybridSearch(query, queryEmb, searchOpts);
    } else if (useSemantic) {
      const queryEmb = await this.embeddings.embed(query);
      results = this.store.semanticSearch(queryEmb, searchOpts);
    } else if (useFullText) {
      results = this.store.fullTextSearch(query, searchOpts);
    } else {
      results = [];
    }

    return results.map((r) => r.chunk);
  }

  /**
   * Forget (delete) a memory by id.
   */
  async forget(id: string): Promise<void> {
    this.ensureOpen();
    this.store.delete(id);
  }

  // ── Tier Management ───────────────────────────────────────────────────

  /**
   * Promote a chunk to long-term memory.
   */
  async promoteToLongTerm(id: string): Promise<void> {
    this.ensureOpen();
    const chunk = this.store.get(id);
    if (!chunk) {
      throw new Error(`Chunk not found: ${id}`);
    }
    this.store.promote(id, "long_term");
  }

  /**
   * Run a decay cycle: move expired short-term entries to episodic.
   * Returns the number of chunks decayed.
   */
  async runDecayCycle(): Promise<number> {
    this.ensureOpen();
    return this.maintenance.runDecayCycle();
  }

  /**
   * Run a promotion cycle: evaluate short-term entries for long-term promotion.
   * Returns the number of chunks promoted.
   */
  async runPromotionCycle(): Promise<number> {
    this.ensureOpen();
    return this.maintenance.runPromotionCycle();
  }

  // ── Context Injection ─────────────────────────────────────────────────

  /**
   * Assemble context for injection into an LLM prompt.
   * This is the primary integration point with the agent framework.
   */
  async assembleContext(signals: QuerySignals): Promise<AssembledContext> {
    this.ensureOpen();
    return this.injector.assembleContext(signals);
  }

  // ── Direct Store Access ───────────────────────────────────────────────

  /** Get a single chunk by id. */
  getChunk(id: string): MemoryChunk | null {
    this.ensureOpen();
    return this.store.get(id);
  }

  /** Get all chunks in a tier. */
  getByTier(tier: MemoryTier, opts?: { limit?: number; offset?: number }): MemoryChunk[] {
    this.ensureOpen();
    return this.store.getByTier(tier, opts);
  }

  /** Get all chunks for a person. */
  getByPerson(person: string, opts?: { limit?: number; offset?: number }): MemoryChunk[] {
    this.ensureOpen();
    return this.store.getByPerson(person, opts);
  }

  /** Get aggregate statistics. */
  stats(): MemoryStats {
    this.ensureOpen();
    return this.store.stats();
  }

  /** Access the underlying store (for advanced operations). */
  getStore(): MemoryStore {
    return this.store;
  }

  /** Access the embedding provider (may be null). */
  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddings;
  }

  /** Access the context injector. */
  getContextInjector(): ContextInjector {
    return this.injector;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Initialize (already done in create(), but exposed for re-init). */
  async init(): Promise<void> {
    // no-op — everything is initialized in create()
  }

  /** Graceful shutdown. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.store.close();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("MemorySystem is closed");
    }
  }
}
