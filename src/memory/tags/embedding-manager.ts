/**
 * Tag Embedding Manager for Hephie's memory system.
 *
 * Manages the lifecycle of tag embeddings: auto-embedding new tags,
 * semantic similarity search, and hybrid exact+semantic tag matching.
 *
 * Usage:
 *   const manager = new TagEmbeddingManager(store, embeddingProvider);
 *   await manager.embedAllTags(chunk.tags);
 *   const similar = await manager.findSimilarTags("ML");
 *   // → [{ tag: "machine learning", category: "concepts", similarity: 0.92 }, ...]
 */

import type { EmbeddingProvider } from "../embeddings/types.js";
import type { MemoryStore } from "../storage/sqlite-store.js";
import type { MemoryTags, TagCategory, TagSimilarityResult } from "../storage/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from hybrid tag search combining exact and semantic matching. */
export interface HybridTagResult {
  tag: string;
  category: TagCategory;
  score: number;
  matchType: "exact" | "semantic";
}

/** Options for similarity search. */
export interface FindSimilarOpts {
  /** Filter to a specific tag category. */
  category?: TagCategory;
  /** Maximum results to return (default 10). */
  limit?: number;
  /** Minimum cosine similarity threshold (default 0.5). */
  minSimilarity?: number;
}

/** Options for hybrid search. */
export interface HybridSearchOpts {
  /** Filter to a specific tag category. */
  category?: TagCategory;
  /** Maximum results to return (default 10). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// TagEmbeddingManager
// ---------------------------------------------------------------------------

export class TagEmbeddingManager {
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingProvider;

  constructor(store: MemoryStore, embeddings: EmbeddingProvider) {
    this.store = store;
    this.embeddings = embeddings;
  }

  /**
   * Embed and store a single tag (idempotent — skips if already embedded
   * for the given category).
   */
  async embedTag(tag: string, category: TagCategory): Promise<void> {
    // Check if already embedded
    const existing = this.store.getTagEmbedding(tag, category);
    if (existing) {
      return; // Already embedded — idempotent
    }

    const vector = await this.embeddings.embed(tag);
    this.store.upsertTagEmbedding({
      tag,
      category,
      embedding: new Float32Array(vector),
    });
  }

  /**
   * Embed all tags from a MemoryTags object.
   * Skips tags that are already embedded (idempotent).
   */
  async embedAllTags(tags: MemoryTags): Promise<void> {
    const dimensions: Array<[TagCategory, string[]]> = [
      ["concepts", tags.concepts],
      ["specialized", tags.specialized],
      ["people", tags.people],
      ["places", tags.places],
      ["projects", tags.projects],
    ];

    // Collect all tags that need embedding
    const toEmbed: Array<{ tag: string; category: TagCategory }> = [];
    for (const [category, values] of dimensions) {
      for (const tag of values) {
        const existing = this.store.getTagEmbedding(tag, category);
        if (!existing) {
          toEmbed.push({ tag, category });
        }
      }
    }

    if (toEmbed.length === 0) {
      return;
    }

    // Batch embed all new tags
    const texts = toEmbed.map((t) => t.tag);
    const vectors = await this.embeddings.embedBatch(texts);

    for (let i = 0; i < toEmbed.length; i++) {
      this.store.upsertTagEmbedding({
        tag: toEmbed[i].tag,
        category: toEmbed[i].category,
        embedding: new Float32Array(vectors[i]),
      });
    }
  }

  /**
   * Find semantically similar tags to a query string.
   *
   * Embeds the query and finds tags whose embeddings are most similar.
   */
  async findSimilarTags(query: string, opts: FindSimilarOpts = {}): Promise<TagSimilarityResult[]> {
    const limit = opts.limit ?? 10;
    const minSimilarity = opts.minSimilarity ?? 0.5;

    const queryVector = await this.embeddings.embed(query);
    const queryEmbedding = new Float32Array(queryVector);

    return this.store.findSimilarTags(queryEmbedding, opts.category, minSimilarity, limit);
  }

  /**
   * Hybrid tag search: combines exact string matching (2x boost) with
   * semantic similarity matching (1.5x boost).
   *
   * Exact matches always rank higher than semantic-only matches.
   */
  async hybridTagSearch(query: string, opts: HybridSearchOpts = {}): Promise<HybridTagResult[]> {
    const limit = opts.limit ?? 10;
    const queryLower = query.toLowerCase();

    // 1. Get all known tags to check for exact matches
    const allTags = this.store.getAllTags(opts.category);

    // 2. Find exact matches (case-insensitive substring/full match)
    const exactMatches: HybridTagResult[] = [];
    for (const { tag, category } of allTags) {
      const tagLower = tag.toLowerCase();
      if (
        tagLower === queryLower ||
        tagLower.includes(queryLower) ||
        queryLower.includes(tagLower)
      ) {
        exactMatches.push({
          tag,
          category,
          score: 2.0, // Exact match boost
          matchType: "exact",
        });
      }
    }

    // 3. Find semantic matches
    const semanticResults = await this.findSimilarTags(query, {
      category: opts.category,
      limit: limit * 2, // Over-fetch to allow dedup
      minSimilarity: 0.5,
    });

    // 4. Merge: exact matches take priority, semantic fills the rest
    const seen = new Set<string>();
    const results: HybridTagResult[] = [];

    // Add exact matches first
    for (const exact of exactMatches) {
      const key = `${exact.tag}:${exact.category}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(exact);
      }
    }

    // Add semantic matches (skip if already an exact match)
    for (const sem of semanticResults) {
      const key = `${sem.tag}:${sem.category}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          tag: sem.tag,
          category: sem.category,
          score: 1.5 * sem.similarity, // Semantic match boost
          matchType: "semantic",
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  /**
   * Get all known tags, optionally filtered by category.
   */
  async listTags(category?: TagCategory): Promise<Array<{ tag: string; category: TagCategory }>> {
    return this.store.getAllTags(category);
  }

  /**
   * Batch embed all tags that exist in memory chunks but don't yet have
   * embeddings in the tag_embeddings table.
   *
   * Scans all chunks in the store, extracts their tags, and embeds any
   * that are missing.
   *
   * @returns The number of newly embedded tags.
   */
  async embedMissingTags(): Promise<number> {
    // Collect all unique tags from all chunks across all tiers
    const allTags = new Map<string, TagCategory>(); // key: "tag:category"

    for (const tier of ["working", "short_term", "long_term", "episodic"] as const) {
      const chunks = this.store.getByTier(tier, { limit: 10000 });
      for (const chunk of chunks) {
        if (!chunk.tags) {
          continue;
        }

        const dimensions: Array<[TagCategory, string[]]> = [
          ["concepts", chunk.tags.concepts],
          ["specialized", chunk.tags.specialized],
          ["people", chunk.tags.people],
          ["places", chunk.tags.places],
          ["projects", chunk.tags.projects],
        ];

        for (const [category, values] of dimensions) {
          for (const tag of values) {
            const key = `${tag}:${category}`;
            if (!allTags.has(key)) {
              allTags.set(key, category);
            }
          }
        }
      }
    }

    // Filter to only unembedded tags
    const toEmbed: Array<{ tag: string; category: TagCategory }> = [];
    for (const [key, category] of allTags) {
      const tag = key.slice(0, key.lastIndexOf(":"));
      const existing = this.store.getTagEmbedding(tag, category);
      if (!existing) {
        toEmbed.push({ tag, category });
      }
    }

    if (toEmbed.length === 0) {
      return 0;
    }

    // Batch embed
    const texts = toEmbed.map((t) => t.tag);
    const vectors = await this.embeddings.embedBatch(texts);

    for (let i = 0; i < toEmbed.length; i++) {
      this.store.upsertTagEmbedding({
        tag: toEmbed[i].tag,
        category: toEmbed[i].category,
        embedding: new Float32Array(vectors[i]),
      });
    }

    return toEmbed.length;
  }
}
