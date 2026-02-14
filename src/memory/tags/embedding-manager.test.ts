/**
 * Tests for TagEmbeddingManager.
 *
 * Uses a mock embedding provider that returns deterministic vectors
 * based on known semantic clusters, so we can test similarity without
 * needing the real MiniLM model.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { MemoryTags } from "../storage/types.js";
import { MemoryStore } from "../storage/sqlite-store.js";
import { TagEmbeddingManager } from "./embedding-manager.js";

// ---------------------------------------------------------------------------
// Mock embedding provider
// ---------------------------------------------------------------------------

/**
 * A mock embedding provider that maps known terms to deterministic vectors.
 * Terms in the same semantic cluster get similar vectors.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = "mock-test-model";
  readonly dimensions = 8;

  /** Known term → vector mapping for deterministic similarity tests. */
  private readonly vectors: Record<string, number[]> = {
    // ML cluster — all very similar
    "machine learning": [0.9, 0.8, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0],
    ML: [0.88, 0.82, 0.12, 0.0, 0.0, 0.0, 0.0, 0.0],
    "deep learning": [0.85, 0.78, 0.15, 0.05, 0.0, 0.0, 0.0, 0.0],
    "neural networks": [0.82, 0.75, 0.18, 0.08, 0.0, 0.0, 0.0, 0.0],
    "neural nets": [0.83, 0.76, 0.17, 0.07, 0.0, 0.0, 0.0, 0.0],

    // Infrastructure cluster
    infrastructure: [0.0, 0.0, 0.0, 0.0, 0.9, 0.8, 0.1, 0.0],
    deployment: [0.0, 0.0, 0.0, 0.0, 0.85, 0.78, 0.15, 0.05],
    Docker: [0.0, 0.0, 0.0, 0.0, 0.82, 0.75, 0.18, 0.08],
    Kubernetes: [0.0, 0.0, 0.0, 0.0, 0.8, 0.73, 0.2, 0.1],

    // People cluster
    Antreas: [0.0, 0.0, 0.9, 0.8, 0.0, 0.0, 0.0, 0.1],
    Laura: [0.0, 0.0, 0.85, 0.82, 0.0, 0.0, 0.0, 0.15],

    // Places cluster
    Edinburgh: [0.1, 0.0, 0.0, 0.0, 0.0, 0.1, 0.9, 0.8],
    Scotland: [0.12, 0.0, 0.0, 0.0, 0.0, 0.12, 0.88, 0.78],
    Cyprus: [0.1, 0.0, 0.0, 0.0, 0.0, 0.1, 0.8, 0.85],

    // Projects
    Hephie: [0.0, 0.5, 0.0, 0.0, 0.5, 0.0, 0.0, 0.5],
    OpenClaw: [0.0, 0.48, 0.0, 0.0, 0.52, 0.0, 0.0, 0.48],
  };

  async embed(text: string): Promise<number[]> {
    const known = this.vectors[text];
    if (known) {
      return this.normalize([...known]);
    }
    // Unknown terms: generate a pseudo-random but deterministic vector
    return this.normalize(this.hashVector(text));
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private normalize(v: number[]): number[] {
    let mag = 0;
    for (const x of v) {
      mag += x * x;
    }
    mag = Math.sqrt(mag);
    if (mag < 1e-10) {
      return v;
    }
    return v.map((x) => x / mag);
  }

  private hashVector(text: string): number[] {
    // Simple deterministic hash → vector
    const vec = Array.from({ length: this.dimensions }, () => 0);
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dimensions] += text.charCodeAt(i) / 255;
    }
    return vec;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TagEmbeddingManager", () => {
  let store: MemoryStore;
  let provider: MockEmbeddingProvider;
  let manager: TagEmbeddingManager;

  beforeEach(async () => {
    store = await MemoryStore.open({ dbPath: ":memory:" });
    provider = new MockEmbeddingProvider();
    manager = new TagEmbeddingManager(store, provider);
  });

  afterEach(() => {
    store.close();
  });

  // ── embedTag ──────────────────────────────────────────────────────────

  describe("embedTag", () => {
    it("should embed and store a new tag", async () => {
      await manager.embedTag("machine learning", "concepts");

      const retrieved = store.getTagEmbedding("machine learning", "concepts");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.tag).toBe("machine learning");
      expect(retrieved!.category).toBe("concepts");
      expect(retrieved!.embedding.length).toBe(provider.dimensions);
    });

    it("should be idempotent — skip if already embedded", async () => {
      await manager.embedTag("machine learning", "concepts");
      const first = store.getTagEmbedding("machine learning", "concepts");

      // Embed again — should not change
      await manager.embedTag("machine learning", "concepts");
      const second = store.getTagEmbedding("machine learning", "concepts");

      expect(first!.createdAt).toBe(second!.createdAt);
    });

    it("should embed same tag in different categories independently", async () => {
      await manager.embedTag("Python", "concepts");
      await manager.embedTag("Python", "specialized");

      expect(store.getTagEmbedding("Python", "concepts")).not.toBeNull();
      expect(store.getTagEmbedding("Python", "specialized")).not.toBeNull();
    });
  });

  // ── embedAllTags ──────────────────────────────────────────────────────

  describe("embedAllTags", () => {
    it("should embed all tags from a MemoryTags object", async () => {
      const tags: MemoryTags = {
        concepts: ["machine learning", "deep learning"],
        specialized: ["neural networks"],
        people: ["Antreas"],
        places: ["Edinburgh"],
        projects: ["Hephie"],
      };

      await manager.embedAllTags(tags);

      expect(store.getTagEmbedding("machine learning", "concepts")).not.toBeNull();
      expect(store.getTagEmbedding("deep learning", "concepts")).not.toBeNull();
      expect(store.getTagEmbedding("neural networks", "specialized")).not.toBeNull();
      expect(store.getTagEmbedding("Antreas", "people")).not.toBeNull();
      expect(store.getTagEmbedding("Edinburgh", "places")).not.toBeNull();
      expect(store.getTagEmbedding("Hephie", "projects")).not.toBeNull();
    });

    it("should skip already-embedded tags", async () => {
      // Pre-embed one tag
      await manager.embedTag("machine learning", "concepts");

      const tags: MemoryTags = {
        concepts: ["machine learning", "deep learning"],
        specialized: [],
        people: [],
        places: [],
        projects: [],
      };

      await manager.embedAllTags(tags);

      // Both should exist
      expect(store.getTagEmbedding("machine learning", "concepts")).not.toBeNull();
      expect(store.getTagEmbedding("deep learning", "concepts")).not.toBeNull();
    });

    it("should handle empty tags gracefully", async () => {
      const tags: MemoryTags = {
        concepts: [],
        specialized: [],
        people: [],
        places: [],
        projects: [],
      };

      // Should not throw
      await manager.embedAllTags(tags);
    });
  });

  // ── findSimilarTags ───────────────────────────────────────────────────

  describe("findSimilarTags", () => {
    beforeEach(async () => {
      const tags: MemoryTags = {
        concepts: ["machine learning", "deep learning", "infrastructure"],
        specialized: ["neural networks", "Docker", "Kubernetes"],
        people: ["Antreas"],
        places: ["Edinburgh"],
        projects: ["Hephie"],
      };
      await manager.embedAllTags(tags);
    });

    it("should find 'machine learning' when searching for 'ML'", async () => {
      const results = await manager.findSimilarTags("ML", { minSimilarity: 0.8 });

      const tags = results.map((r) => r.tag);
      expect(tags).toContain("machine learning");
    });

    it("should find 'deep learning' and 'neural networks' for 'neural nets'", async () => {
      const results = await manager.findSimilarTags("neural nets", { minSimilarity: 0.8 });

      const tags = results.map((r) => r.tag);
      expect(tags).toContain("neural networks");
      expect(tags).toContain("deep learning");
    });

    it("should NOT find infrastructure tags when searching ML terms", async () => {
      const results = await manager.findSimilarTags("ML", { minSimilarity: 0.5 });

      const tags = results.map((r) => r.tag);
      expect(tags).not.toContain("infrastructure");
      expect(tags).not.toContain("Docker");
      expect(tags).not.toContain("Edinburgh");
    });

    it("should filter by category", async () => {
      const results = await manager.findSimilarTags("ML", {
        category: "specialized",
        minSimilarity: 0.5,
      });

      // Should only return specialized tags
      expect(results.every((r) => r.category === "specialized")).toBe(true);
    });

    it("should respect limit", async () => {
      const results = await manager.findSimilarTags("ML", {
        minSimilarity: 0.0,
        limit: 2,
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should sort results by similarity descending", async () => {
      const results = await manager.findSimilarTags("ML", { minSimilarity: 0.0 });

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
      }
    });
  });

  // ── hybridTagSearch ───────────────────────────────────────────────────

  describe("hybridTagSearch", () => {
    beforeEach(async () => {
      const tags: MemoryTags = {
        concepts: ["machine learning", "deep learning", "infrastructure"],
        specialized: ["neural networks", "ML", "Docker"],
        people: [],
        places: [],
        projects: [],
      };
      await manager.embedAllTags(tags);
    });

    it("exact match scores higher than semantic match", async () => {
      const results = await manager.hybridTagSearch("ML");

      // "ML" should be an exact match (score = 2.0)
      const exactML = results.find((r) => r.tag === "ML" && r.matchType === "exact");
      expect(exactML).toBeDefined();
      expect(exactML!.score).toBe(2.0);

      // "machine learning" should be a semantic match (score < 2.0)
      const semanticML = results.find(
        (r) => r.tag === "machine learning" && r.matchType === "semantic",
      );
      expect(semanticML).toBeDefined();
      expect(semanticML!.score).toBeLessThan(2.0);

      // Exact match should rank higher
      const exactIdx = results.indexOf(exactML!);
      const semIdx = results.indexOf(semanticML!);
      expect(exactIdx).toBeLessThan(semIdx);
    });

    it("should return semantic matches for terms not in tags", async () => {
      const results = await manager.hybridTagSearch("neural nets");

      // No exact match for "neural nets", but "neural networks" should appear
      const nn = results.find((r) => r.tag === "neural networks");
      expect(nn).toBeDefined();
      expect(nn!.matchType).toBe("semantic");
    });

    it("should filter by category", async () => {
      const results = await manager.hybridTagSearch("ML", {
        category: "concepts",
      });

      expect(results.every((r) => r.category === "concepts")).toBe(true);
      // "ML" is in specialized, not concepts — so no exact match here
      expect(results.find((r) => r.tag === "ML")).toBeUndefined();
    });

    it("should respect limit", async () => {
      const results = await manager.hybridTagSearch("ML", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  // ── listTags ──────────────────────────────────────────────────────────

  describe("listTags", () => {
    it("should list all embedded tags", async () => {
      await manager.embedTag("machine learning", "concepts");
      await manager.embedTag("Docker", "specialized");
      await manager.embedTag("Edinburgh", "places");

      const all = await manager.listTags();
      expect(all.length).toBe(3);
      expect(all.map((t) => t.tag).toSorted()).toEqual(["Docker", "Edinburgh", "machine learning"]);
    });

    it("should filter by category", async () => {
      await manager.embedTag("machine learning", "concepts");
      await manager.embedTag("deep learning", "concepts");
      await manager.embedTag("Docker", "specialized");

      const concepts = await manager.listTags("concepts");
      expect(concepts.length).toBe(2);
      expect(concepts.every((t) => t.category === "concepts")).toBe(true);
    });

    it("should return empty for no tags", async () => {
      const results = await manager.listTags();
      expect(results.length).toBe(0);
    });
  });

  // ── embedMissingTags ──────────────────────────────────────────────────

  describe("embedMissingTags", () => {
    it("should embed tags from chunks that lack embeddings", async () => {
      // Insert chunks with tags
      store.insert({
        tier: "short_term",
        content: "Some ML content",
        tags: {
          concepts: ["machine learning"],
          specialized: ["neural networks"],
          people: [],
          places: [],
          projects: [],
        },
      });

      store.insert({
        tier: "long_term",
        content: "Infrastructure content",
        tags: {
          concepts: ["infrastructure"],
          specialized: ["Docker"],
          people: [],
          places: [],
          projects: [],
        },
      });

      const count = await manager.embedMissingTags();
      expect(count).toBe(4); // 4 unique tags

      // All should now have embeddings
      expect(store.getTagEmbedding("machine learning", "concepts")).not.toBeNull();
      expect(store.getTagEmbedding("neural networks", "specialized")).not.toBeNull();
      expect(store.getTagEmbedding("infrastructure", "concepts")).not.toBeNull();
      expect(store.getTagEmbedding("Docker", "specialized")).not.toBeNull();
    });

    it("should skip already-embedded tags", async () => {
      // Pre-embed one tag
      await manager.embedTag("machine learning", "concepts");

      // Insert a chunk with that tag + a new one
      store.insert({
        tier: "short_term",
        content: "Some ML content",
        tags: {
          concepts: ["machine learning", "deep learning"],
          specialized: [],
          people: [],
          places: [],
          projects: [],
        },
      });

      const count = await manager.embedMissingTags();
      expect(count).toBe(1); // Only "deep learning" should be new

      expect(store.getTagEmbedding("deep learning", "concepts")).not.toBeNull();
    });

    it("should return 0 when all tags are already embedded", async () => {
      await manager.embedTag("machine learning", "concepts");

      store.insert({
        tier: "short_term",
        content: "ML content",
        tags: {
          concepts: ["machine learning"],
          specialized: [],
          people: [],
          places: [],
          projects: [],
        },
      });

      const count = await manager.embedMissingTags();
      expect(count).toBe(0);
    });

    it("should return 0 when no chunks have tags", async () => {
      store.insert({
        tier: "short_term",
        content: "no tags here",
      });

      const count = await manager.embedMissingTags();
      expect(count).toBe(0);
    });

    it("should handle tags across multiple tiers", async () => {
      store.insert({
        tier: "working",
        content: "working memory",
        tags: {
          concepts: ["testing"],
          specialized: [],
          people: [],
          places: [],
          projects: [],
        },
      });

      store.insert({
        tier: "short_term",
        content: "short term",
        tags: {
          concepts: [],
          specialized: ["Docker"],
          people: [],
          places: [],
          projects: [],
        },
      });

      store.insert({
        tier: "long_term",
        content: "long term",
        tags: {
          concepts: [],
          specialized: [],
          people: ["Antreas"],
          places: [],
          projects: [],
        },
      });

      store.insert({
        tier: "episodic",
        content: "episodic",
        tags: {
          concepts: [],
          specialized: [],
          people: [],
          places: ["Edinburgh"],
          projects: [],
        },
      });

      const count = await manager.embedMissingTags();
      expect(count).toBe(4);
    });
  });

  // ── Integration: tagBoostedSearch with semantic tags ───────────────────

  describe("integration with tagBoostedSearch", () => {
    it("semantic tags enable boosting for chunks with related tags", async () => {
      // Set up tag embeddings
      await manager.embedAllTags({
        concepts: ["machine learning", "infrastructure"],
        specialized: ["neural networks"],
        people: [],
        places: [],
        projects: [],
      });

      // Insert chunks with tags (no vector embeddings — FTS only for this test)
      store.insert({
        tier: "short_term",
        content: "Training a neural network model with PyTorch for image classification",
        tags: {
          concepts: ["machine learning"],
          specialized: ["neural networks"],
          people: [],
          places: [],
          projects: [],
        },
      });

      store.insert({
        tier: "short_term",
        content: "Setting up Docker containers for the production infrastructure",
        tags: {
          concepts: ["infrastructure"],
          specialized: [],
          people: [],
          places: [],
          projects: [],
        },
      });

      // Use findSimilarTags to get semantic matches for "ML"
      const similarTags = await manager.findSimilarTags("ML", { minSimilarity: 0.5 });

      // Should find ML-related tags
      const tagNames = similarTags.map((t) => t.tag);
      expect(tagNames).toContain("machine learning");
      expect(tagNames).toContain("neural networks");
      expect(tagNames).not.toContain("infrastructure");
    });
  });
});
