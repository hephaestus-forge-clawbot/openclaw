/**
 * Tests for tag embedding operations in MemoryStore.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { TagEmbeddingInput } from "./types.js";
import { MemoryStore } from "./sqlite-store.js";

describe("MemoryStore Tag Embeddings", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await MemoryStore.open({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  describe("upsertTagEmbedding", () => {
    it("should store a new tag embedding", () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3]);
      const input: TagEmbeddingInput = {
        tag: "machine learning",
        category: "concepts",
        embedding,
      };

      store.upsertTagEmbedding(input);

      const retrieved = store.getTagEmbedding("machine learning", "concepts");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.tag).toBe("machine learning");
      expect(retrieved!.category).toBe("concepts");
      // Float32Array has precision limits
      expect(retrieved!.embedding[0]).toBeCloseTo(0.1, 5);
      expect(retrieved!.embedding[1]).toBeCloseTo(0.2, 5);
      expect(retrieved!.embedding[2]).toBeCloseTo(0.3, 5);
    });

    it("should update an existing tag embedding", () => {
      const embedding1 = new Float32Array([0.1, 0.2, 0.3]);
      const embedding2 = new Float32Array([0.4, 0.5, 0.6]);

      store.upsertTagEmbedding({
        tag: "ML",
        category: "specialized",
        embedding: embedding1,
      });

      store.upsertTagEmbedding({
        tag: "ML",
        category: "specialized",
        embedding: embedding2,
      });

      const retrieved = store.getTagEmbedding("ML", "specialized");
      // Float32Array has precision limits
      expect(retrieved!.embedding[0]).toBeCloseTo(0.4, 5);
      expect(retrieved!.embedding[1]).toBeCloseTo(0.5, 5);
      expect(retrieved!.embedding[2]).toBeCloseTo(0.6, 5);
    });

    it("should store same tag in different categories", () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3]);

      store.upsertTagEmbedding({
        tag: "Edinburgh",
        category: "places",
        embedding,
      });

      store.upsertTagEmbedding({
        tag: "Edinburgh",
        category: "projects",
        embedding,
      });

      const asPlace = store.getTagEmbedding("Edinburgh", "places");
      const asProject = store.getTagEmbedding("Edinburgh", "projects");

      expect(asPlace).not.toBeNull();
      expect(asProject).not.toBeNull();
      expect(asPlace!.category).toBe("places");
      expect(asProject!.category).toBe("projects");
    });
  });

  describe("getTagEmbedding", () => {
    it("should return null for non-existent tag", () => {
      const result = store.getTagEmbedding("nonexistent", "concepts");
      expect(result).toBeNull();
    });

    it("should return null for wrong category", () => {
      store.upsertTagEmbedding({
        tag: "Python",
        category: "specialized",
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      });

      const result = store.getTagEmbedding("Python", "concepts");
      expect(result).toBeNull();
    });
  });

  describe("findSimilarTags", () => {
    beforeEach(() => {
      // Set up a test embedding space
      // "ML" and "machine learning" should be similar
      // "Python" and "programming" should be similar
      // "ML" and "Python" should be less similar

      store.upsertTagEmbedding({
        tag: "ML",
        category: "specialized",
        embedding: new Float32Array([0.9, 0.1, 0.0]),
      });

      store.upsertTagEmbedding({
        tag: "machine learning",
        category: "concepts",
        embedding: new Float32Array([0.85, 0.15, 0.05]),
      });

      store.upsertTagEmbedding({
        tag: "Python",
        category: "specialized",
        embedding: new Float32Array([0.1, 0.9, 0.0]),
      });

      store.upsertTagEmbedding({
        tag: "programming",
        category: "concepts",
        embedding: new Float32Array([0.15, 0.85, 0.05]),
      });

      store.upsertTagEmbedding({
        tag: "Edinburgh",
        category: "places",
        embedding: new Float32Array([0.0, 0.0, 1.0]),
      });
    });

    it("should find similar tags across all categories", () => {
      const query = new Float32Array([0.9, 0.1, 0.0]); // Similar to "ML"
      const results = store.findSimilarTags(query, undefined, 0.8);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tag).toBe("ML"); // Exact match should be first
      expect(results[0].similarity).toBeGreaterThan(0.99);

      // "machine learning" should also match
      const mlResult = results.find((r) => r.tag === "machine learning");
      expect(mlResult).toBeDefined();
      expect(mlResult!.similarity).toBeGreaterThan(0.8);
    });

    it("should filter by category", () => {
      const query = new Float32Array([0.9, 0.1, 0.0]);
      const results = store.findSimilarTags(query, "specialized", 0.5);

      expect(results.every((r) => r.category === "specialized")).toBe(true);
      expect(results.find((r) => r.tag === "ML")).toBeDefined();
      expect(results.find((r) => r.tag === "machine learning")).toBeUndefined(); // different category
    });

    it("should respect minimum similarity threshold", () => {
      const query = new Float32Array([0.9, 0.1, 0.0]);
      const results = store.findSimilarTags(query, undefined, 0.95);

      // Only very similar tags should match
      expect(results.every((r) => r.similarity >= 0.95)).toBe(true);
      expect(results.find((r) => r.tag === "Edinburgh")).toBeUndefined(); // Too different
    });

    it("should respect limit parameter", () => {
      const query = new Float32Array([0.9, 0.1, 0.0]);
      const results = store.findSimilarTags(query, undefined, 0.0, 2);

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should sort by similarity descending", () => {
      const query = new Float32Array([0.9, 0.1, 0.0]);
      const results = store.findSimilarTags(query, undefined, 0.5);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
      }
    });
  });

  describe("getAllTags", () => {
    beforeEach(() => {
      const embedding = new Float32Array([0.1, 0.2, 0.3]);

      store.upsertTagEmbedding({ tag: "Python", category: "specialized", embedding });
      store.upsertTagEmbedding({ tag: "Edinburgh", category: "places", embedding });
      store.upsertTagEmbedding({ tag: "Hephie", category: "projects", embedding });
      store.upsertTagEmbedding({ tag: "ML", category: "concepts", embedding });
    });

    it("should return all tags across all categories", () => {
      const results = store.getAllTags();

      expect(results.length).toBe(4);
      expect(results.map((r) => r.tag).toSorted()).toEqual(["Edinburgh", "Hephie", "ML", "Python"]);
    });

    it("should filter by category", () => {
      const results = store.getAllTags("specialized");

      expect(results.length).toBe(1);
      expect(results[0].tag).toBe("Python");
      expect(results[0].category).toBe("specialized");
    });

    it("should return empty array for category with no tags", () => {
      const results = store.getAllTags("people");
      expect(results.length).toBe(0);
    });

    it("should return tags in alphabetical order", () => {
      const results = store.getAllTags();
      const tags = results.map((r) => r.tag);

      expect(tags).toEqual([...tags].toSorted());
    });
  });

  describe("deleteTagEmbedding", () => {
    it("should delete a specific tag embedding", () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3]);

      store.upsertTagEmbedding({ tag: "Python", category: "specialized", embedding });
      store.upsertTagEmbedding({ tag: "Python", category: "concepts", embedding });

      store.deleteTagEmbedding("Python", "specialized");

      expect(store.getTagEmbedding("Python", "specialized")).toBeNull();
      expect(store.getTagEmbedding("Python", "concepts")).not.toBeNull();
    });

    it("should be idempotent", () => {
      store.deleteTagEmbedding("nonexistent", "concepts");
      // Should not throw
    });
  });

  describe("integration: semantic tag search workflow", () => {
    it("should enable 'ML' to find 'machine learning' and 'deep learning'", () => {
      // Simulate embeddings from a real model (MiniLM-L6-v2 style vectors)
      store.upsertTagEmbedding({
        tag: "machine learning",
        category: "concepts",
        embedding: new Float32Array([0.8, 0.6, 0.1]),
      });

      store.upsertTagEmbedding({
        tag: "deep learning",
        category: "concepts",
        embedding: new Float32Array([0.75, 0.65, 0.15]),
      });

      store.upsertTagEmbedding({
        tag: "neural networks",
        category: "specialized",
        embedding: new Float32Array([0.78, 0.62, 0.12]),
      });

      store.upsertTagEmbedding({
        tag: "data analysis",
        category: "concepts",
        embedding: new Float32Array([0.3, 0.4, 0.8]),
      });

      // Query with "ML" embedding (similar to machine learning cluster)
      const queryEmbedding = new Float32Array([0.82, 0.58, 0.08]);

      const results = store.findSimilarTags(queryEmbedding, undefined, 0.85);

      expect(results.length).toBeGreaterThan(0);

      const tags = results.map((r) => r.tag);
      expect(tags).toContain("machine learning");
      expect(tags).toContain("deep learning");
      expect(tags).toContain("neural networks");
      expect(tags).not.toContain("data analysis"); // Too different
    });
  });
});
