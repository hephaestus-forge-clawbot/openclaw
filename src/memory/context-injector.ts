/**
 * Hephie Context Injection Pipeline
 *
 * Assembles relevant memories into structured context blocks for injection
 * into LLM prompts. The pipeline:
 *
 *   1. Extract query signals (topics, people, intent)
 *   2. Query Short-Term memory (last 7 days, semantic match) → top 5
 *   3. Query Long-Term memory (all time, semantic match) → top 10
 *   4. If a person is identified, boost their tagged facts
 *   5. Budget allocation: Working 60%, Short-Term 15%, Long-Term 20%, System 5%
 *   6. Estimate token count per chunk (rough: chars/4)
 *   7. Fill each tier's budget with highest-relevance chunks
 *   8. Format as structured sections for system prompt injection
 */

import type { EmbeddingProvider } from "./embeddings/types.js";
import type { MemoryStore } from "./storage/sqlite-store.js";
import type { MemoryChunk, MemoryTier, SearchResult } from "./storage/types.js";

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Signals extracted from the current conversation turn.
 * The ContextInjector uses these to decide what memories to retrieve.
 */
export interface QuerySignals {
  /** The raw current message from the user/channel. */
  currentMessage: string;

  /** People mentioned or detected in the current message. */
  peopleMentioned?: string[];

  /** The person we're currently talking to (for compartmentalization). */
  currentPerson?: string;

  /** Topic keywords extracted from the message. */
  topicKeywords?: string[];

  /** The channel this message came from. */
  channel?: string;

  /** The session ID. */
  sessionId?: string;

  /** Total token budget for assembled context (default: 4000). */
  totalTokenBudget?: number;
}

/**
 * Token budget allocation across tiers.
 */
export interface ContextBudget {
  /** Total available tokens for memory injection. Default: 4000. */
  totalTokens: number;

  /** Per-tier allocation as fractions (must sum to 1.0). */
  tierAllocation: {
    working: number;
    short_term: number;
    long_term: number;
    system: number;
  };

  /** Maximum number of chunks to inject per tier. */
  maxChunksPerTier: {
    working: number;
    short_term: number;
    long_term: number;
  };
}

/** A single section in the assembled context. */
export interface ContextSection {
  /** Section header (e.g., "## Recent Context (Short-Term Memory)"). */
  header: string;
  /** The tier this section represents. */
  tier: MemoryTier | "system";
  /** The formatted text content. */
  content: string;
  /** Estimated token count. */
  tokenCount: number;
  /** IDs of chunks included. */
  chunkIds: string[];
  /** Number of chunks that were considered but excluded (budget). */
  excludedCount: number;
}

/** The final assembled context, ready for injection. */
export interface AssembledContext {
  /** Ordered sections. */
  sections: ContextSection[];
  /** Complete assembled text (all sections joined). */
  fullText: string;
  /** Total estimated token count. */
  totalTokens: number;
  /** Total budget. */
  budgetTokens: number;
  /** Utilization ratio. */
  utilization: number;
  /** All chunk IDs included. */
  includedChunkIds: string[];
  /** Assembly duration in ms. */
  assemblyDurationMs: number;
}

// ── Default budget ────────────────────────────────────────────────────────

const DEFAULT_BUDGET: ContextBudget = {
  totalTokens: 4000,
  tierAllocation: {
    working: 0.6,
    short_term: 0.15,
    long_term: 0.2,
    system: 0.05,
  },
  maxChunksPerTier: {
    working: 20,
    short_term: 5,
    long_term: 10,
  },
};

// ── Token estimation ──────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Time formatting ───────────────────────────────────────────────────────

/** Format a unix timestamp as a relative time string. */
function relativeTime(tsMs: number): string {
  const now = Date.now();
  const diffMs = now - tsMs;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin} min ago`;
  }
  if (diffHours < 2) {
    return `${diffHours} hour ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} hours ago`;
  }
  if (diffDays === 1) {
    return "yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  if (diffDays < 30) {
    return `${Math.floor(diffDays / 7)} weeks ago`;
  }
  return `${Math.floor(diffDays / 30)} months ago`;
}

// ── Ranked chunk with score ───────────────────────────────────────────────

interface RankedChunk {
  chunk: MemoryChunk;
  score: number;
}

// ── ContextInjector ───────────────────────────────────────────────────────

export class ContextInjector {
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingProvider | null;
  private readonly budget: ContextBudget;

  constructor(
    store: MemoryStore,
    embeddings: EmbeddingProvider | null,
    budgetOverride?: Partial<ContextBudget>,
  ) {
    this.store = store;
    this.embeddings = embeddings;
    this.budget = {
      ...DEFAULT_BUDGET,
      ...budgetOverride,
      tierAllocation: {
        ...DEFAULT_BUDGET.tierAllocation,
        ...budgetOverride?.tierAllocation,
      },
      maxChunksPerTier: {
        ...DEFAULT_BUDGET.maxChunksPerTier,
        ...budgetOverride?.maxChunksPerTier,
      },
    };
  }

  /**
   * Assemble a context block from memory, given query signals.
   */
  async assembleContext(signals: QuerySignals): Promise<AssembledContext> {
    const start = Date.now();
    const totalBudget = signals.totalTokenBudget ?? this.budget.totalTokens;

    // Step 1: Compute query embedding if we have an embedding provider
    let queryEmbedding: number[] | undefined;
    if (this.embeddings) {
      try {
        queryEmbedding = await this.embeddings.embed(signals.currentMessage);
      } catch {
        // Fall back to FTS-only
      }
    }

    // Step 2: Query Short-Term memory (last 7 days)
    const shortTermChunks = await this.queryTier(
      "short_term",
      signals,
      queryEmbedding,
      this.budget.maxChunksPerTier.short_term,
    );

    // Step 3: Query Long-Term memory (all time)
    const longTermChunks = await this.queryTier(
      "long_term",
      signals,
      queryEmbedding,
      this.budget.maxChunksPerTier.long_term,
    );

    // Step 4: If a person is identified, boost their tagged facts
    let personChunks: RankedChunk[] = [];
    if (signals.currentPerson || (signals.peopleMentioned && signals.peopleMentioned.length > 0)) {
      const people = [
        ...(signals.currentPerson ? [signals.currentPerson] : []),
        ...(signals.peopleMentioned ?? []),
      ];
      personChunks = await this.queryPersonChunks(people, queryEmbedding);
    }

    // Merge person chunks into long-term (boost their scores)
    const mergedLongTerm = this.mergeAndBoostPerson(longTermChunks, personChunks);

    // Step 5: Budget allocation
    const alloc = this.budget.tierAllocation;
    const shortTermBudget = Math.floor(totalBudget * alloc.short_term);
    const longTermBudget = Math.floor(totalBudget * alloc.long_term);

    // Step 6-7: Fill each tier's budget with highest-relevance chunks
    const shortTermSection = this.buildSection(
      "## Recent Context (Short-Term Memory)",
      "short_term",
      shortTermChunks,
      shortTermBudget,
      this.budget.maxChunksPerTier.short_term,
    );

    const longTermSection = this.buildSection(
      "## Known Facts (Long-Term Memory)",
      "long_term",
      mergedLongTerm,
      longTermBudget,
      this.budget.maxChunksPerTier.long_term,
    );

    // Step 8: Format as structured sections
    const sections: ContextSection[] = [];
    if (shortTermSection.content.length > 0) {
      sections.push(shortTermSection);
    }
    if (longTermSection.content.length > 0) {
      sections.push(longTermSection);
    }

    const fullText = sections.map((s) => `${s.header}\n${s.content}`).join("\n\n");
    const totalTokens = estimateTokens(fullText);
    const includedChunkIds = sections.flatMap((s) => s.chunkIds);

    return {
      sections,
      fullText,
      totalTokens,
      budgetTokens: totalBudget,
      utilization: totalBudget > 0 ? totalTokens / totalBudget : 0,
      includedChunkIds,
      assemblyDurationMs: Date.now() - start,
    };
  }

  /**
   * Estimate token count for a string.
   */
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  /**
   * Format a chunk for injection into context.
   */
  formatChunk(chunk: MemoryChunk): string {
    const timeStr = relativeTime(chunk.createdAt);
    const text = chunk.summary ?? chunk.content;

    if (chunk.tier === "short_term" || chunk.tier === "episodic") {
      return `- [${timeStr}] ${text}`;
    }
    // Long-term and working: just the fact
    return `- ${text}`;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Query a specific tier for relevant chunks.
   */
  private async queryTier(
    tier: MemoryTier,
    signals: QuerySignals,
    queryEmbedding: number[] | undefined,
    maxChunks: number,
  ): Promise<RankedChunk[]> {
    const searchOpts = {
      limit: maxChunks * 2, // over-fetch for filtering
      tier,
      person: signals.currentPerson,
    };

    let results: SearchResult[];

    if (queryEmbedding && this.store.isVectorAvailable()) {
      // Hybrid search: semantic + FTS
      results = this.store.hybridSearch(signals.currentMessage, queryEmbedding, searchOpts);
    } else if (this.store.isFtsAvailable()) {
      // FTS only
      results = this.store.fullTextSearch(signals.currentMessage, searchOpts);
    } else {
      // Fallback: get recent chunks from the tier
      const chunks = this.store.getByTier(tier, {
        limit: maxChunks,
        orderBy: "updated_at",
        order: "desc",
      });
      results = chunks.map((c) => ({ chunk: c, score: c.confidence }));
    }

    // Apply compartmentalization filter
    const filtered = results.filter((r) => this.isAccessible(r.chunk, signals));

    return filtered.slice(0, maxChunks).map((r) => ({
      chunk: r.chunk,
      score: r.score,
    }));
  }

  /**
   * Query person-scoped chunks for boosting.
   */
  private async queryPersonChunks(
    people: string[],
    queryEmbedding: number[] | undefined,
  ): Promise<RankedChunk[]> {
    const results: RankedChunk[] = [];

    for (const person of people) {
      const chunks = this.store.getByPerson(person, { limit: 10 });
      for (const chunk of chunks) {
        // Give person chunks a high relevance score (boost)
        results.push({ chunk, score: 0.8 });
      }
    }

    // If we have embeddings, re-rank by similarity
    if (queryEmbedding && results.length > 0 && this.embeddings) {
      // Person chunks are already highly relevant by association,
      // so we keep the 0.8 base score — no need to re-embed.
    }

    return results;
  }

  /**
   * Merge person-boosted chunks into the long-term results.
   * Person chunks get a score boost. Deduplication by chunk id.
   */
  private mergeAndBoostPerson(longTerm: RankedChunk[], person: RankedChunk[]): RankedChunk[] {
    const seen = new Set<string>();
    const merged: RankedChunk[] = [];

    // Person chunks go first with a boost
    for (const pc of person) {
      if (!seen.has(pc.chunk.id)) {
        seen.add(pc.chunk.id);
        merged.push({ chunk: pc.chunk, score: Math.min(pc.score * 1.2, 1.0) });
      }
    }

    // Then long-term chunks
    for (const lt of longTerm) {
      if (!seen.has(lt.chunk.id)) {
        seen.add(lt.chunk.id);
        merged.push(lt);
      }
    }

    // Sort by score descending
    merged.sort((a, b) => b.score - a.score);

    return merged;
  }

  /**
   * Build a context section from ranked chunks within a token budget.
   */
  private buildSection(
    header: string,
    tier: MemoryTier,
    chunks: RankedChunk[],
    tokenBudget: number,
    maxChunks: number,
  ): ContextSection {
    const included: RankedChunk[] = [];
    let tokensUsed = estimateTokens(header + "\n");
    let excludedCount = 0;

    for (const rc of chunks) {
      if (included.length >= maxChunks) {
        excludedCount += chunks.length - included.length - excludedCount;
        break;
      }

      const formatted = this.formatChunk(rc.chunk);
      const chunkTokens = estimateTokens(formatted + "\n");

      if (tokensUsed + chunkTokens > tokenBudget) {
        excludedCount++;
        continue;
      }

      included.push(rc);
      tokensUsed += chunkTokens;
    }

    excludedCount = chunks.length - included.length;

    const content = included.map((rc) => this.formatChunk(rc.chunk)).join("\n");

    return {
      header,
      tier,
      content,
      tokenCount: tokensUsed,
      chunkIds: included.map((rc) => rc.chunk.id),
      excludedCount,
    };
  }

  /**
   * Check if a chunk is accessible in the current context.
   *
   * Compartmentalization rules:
   * - Chunks with no person field are accessible to everyone.
   * - Person-scoped chunks are only accessible when talking to that person,
   *   or if no currentPerson is set (Father context).
   */
  private isAccessible(chunk: MemoryChunk, signals: QuerySignals): boolean {
    if (!chunk.person) {
      return true;
    }

    // If we're in Father context (no specific person), all chunks are visible
    if (!signals.currentPerson) {
      return true;
    }

    // Person-scoped chunks are only visible when talking to that person
    return chunk.person === signals.currentPerson;
  }
}
