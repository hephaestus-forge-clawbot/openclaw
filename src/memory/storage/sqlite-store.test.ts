/**
 * Tests for the Hephie memory storage layer.
 *
 * These tests use in-memory SQLite databases — no disk I/O.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryChunkInput } from "./types.js";
import { MemoryStore } from "./sqlite-store.js";

/** Helper: create an in-memory store. */
async function createStore(opts?: { enableVector?: boolean; enableFts?: boolean }) {
  return MemoryStore.open({
    dbPath: ":memory:",
    embeddingDimensions: 4, // tiny for tests
    enableVector: opts?.enableVector ?? true,
    enableFts: opts?.enableFts ?? true,
  });
}

/** Helper: create a simple chunk input. */
function makeChunk(overrides: Partial<MemoryChunkInput> = {}): MemoryChunkInput {
  return {
    tier: "short_term",
    content: "The quick brown fox jumps over the lazy dog",
    ...overrides,
  };
}

/** Helper: generate a normalized random-ish embedding of given dims. */
function makeEmbedding(dims: number, seed: number = 1): number[] {
  const vec = Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1)));
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / mag);
}

describe("MemoryStore — CRUD", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await createStore();
  });

  afterEach(() => {
    store.close();
  });

  it("inserts and retrieves a chunk", () => {
    const id = store.insert(makeChunk({ content: "hello world" }));
    const chunk = store.get(id);
    expect(chunk).toBeTruthy();
    expect(chunk!.content).toBe("hello world");
    expect(chunk!.tier).toBe("short_term");
    expect(chunk!.confidence).toBe(1.0);
    expect(chunk!.createdAt).toBeGreaterThan(0);
    expect(chunk!.updatedAt).toBeGreaterThan(0);
  });

  it("returns null for non-existent id", () => {
    const chunk = store.get("non-existent-id");
    expect(chunk).toBeNull();
  });

  it("inserts with custom id", () => {
    const id = store.insert(makeChunk({ id: "custom-id-123" }));
    expect(id).toBe("custom-id-123");
    const chunk = store.get(id);
    expect(chunk).toBeTruthy();
    expect(chunk!.id).toBe("custom-id-123");
  });

  it("inserts with all fields", () => {
    const id = store.insert(
      makeChunk({
        tier: "long_term",
        content: "Important memory",
        summary: "A summary",
        source: "telegram:main",
        category: "decision",
        person: "Father",
        tags: ["important", "project-x"],
        confidence: 0.95,
        metadata: { key: "value", nested: { a: 1 } },
      }),
    );
    const chunk = store.get(id)!;
    expect(chunk.tier).toBe("long_term");
    expect(chunk.summary).toBe("A summary");
    expect(chunk.source).toBe("telegram:main");
    expect(chunk.category).toBe("decision");
    expect(chunk.person).toBe("Father");
    expect(chunk.tags).toEqual(["important", "project-x"]);
    expect(chunk.confidence).toBe(0.95);
    expect(chunk.metadata).toEqual({ key: "value", nested: { a: 1 } });
  });

  it("updates a chunk", () => {
    const id = store.insert(makeChunk({ content: "original" }));
    store.update(id, { content: "updated", summary: "now with summary" });

    const chunk = store.get(id)!;
    expect(chunk.content).toBe("updated");
    expect(chunk.summary).toBe("now with summary");
    expect(chunk.updatedAt).toBeGreaterThanOrEqual(chunk.createdAt);
  });

  it("update throws for non-existent id", () => {
    expect(() => store.update("nope", { content: "x" })).toThrow(/not found/);
  });

  it("deletes a chunk", () => {
    const id = store.insert(makeChunk());
    expect(store.get(id)).toBeTruthy();

    store.delete(id);
    expect(store.get(id)).toBeNull();
  });

  it("delete is idempotent (no error for missing id)", () => {
    // Should not throw
    store.delete("already-gone");
  });
});

describe("MemoryStore — Full-Text Search", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await createStore({ enableVector: false, enableFts: true });
  });

  afterEach(() => {
    store.close();
  });

  it("FTS is available", () => {
    expect(store.isFtsAvailable()).toBe(true);
  });

  it("finds chunks by content keyword", () => {
    store.insert(makeChunk({ content: "TypeScript is awesome" }));
    store.insert(makeChunk({ content: "Python is great too" }));
    store.insert(makeChunk({ content: "Rust for systems programming" }));

    const results = store.fullTextSearch("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunk.content).toBe("TypeScript is awesome");
  });

  it("finds chunks by summary", () => {
    store.insert(makeChunk({ content: "some content", summary: "SQLite vector search" }));
    store.insert(makeChunk({ content: "other content", summary: "Redis caching" }));

    const results = store.fullTextSearch("SQLite");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.chunk.summary === "SQLite vector search")).toBe(true);
  });

  it("finds chunks by tags", () => {
    store.insert(makeChunk({ content: "tagged item", tags: ["memory", "hephie"] }));
    store.insert(makeChunk({ content: "untagged item" }));

    const results = store.fullTextSearch("hephie");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.chunk.content === "tagged item")).toBe(true);
  });

  it("returns empty for no matches", () => {
    store.insert(makeChunk({ content: "apples and oranges" }));
    const results = store.fullTextSearch("zyxwvut");
    expect(results.length).toBe(0);
  });

  it("respects tier filter", () => {
    store.insert(makeChunk({ tier: "working", content: "working memory item" }));
    store.insert(makeChunk({ tier: "long_term", content: "long term memory item" }));

    const results = store.fullTextSearch("memory", { tier: "working" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.chunk.tier === "working")).toBe(true);
  });

  it("respects person filter", () => {
    store.insert(makeChunk({ content: "Alice likes cats", person: "Alice" }));
    store.insert(makeChunk({ content: "Bob likes dogs", person: "Bob" }));

    const results = store.fullTextSearch("likes", { person: "Alice" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.chunk.person === "Alice")).toBe(true);
  });

  it("updates FTS index on chunk update", () => {
    const id = store.insert(makeChunk({ content: "original text about cats" }));
    expect(store.fullTextSearch("cats").length).toBeGreaterThanOrEqual(1);

    store.update(id, { content: "new text about dogs" });

    expect(store.fullTextSearch("cats").length).toBe(0);
    expect(store.fullTextSearch("dogs").length).toBeGreaterThanOrEqual(1);
  });

  it("removes from FTS on delete", () => {
    const id = store.insert(makeChunk({ content: "ephemeral thought" }));
    expect(store.fullTextSearch("ephemeral").length).toBeGreaterThanOrEqual(1);

    store.delete(id);
    expect(store.fullTextSearch("ephemeral").length).toBe(0);
  });

  it("respects limit", () => {
    for (let i = 0; i < 20; i++) {
      store.insert(makeChunk({ content: `memory item number ${i}` }));
    }
    const results = store.fullTextSearch("memory", { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

describe("MemoryStore — Vector Search", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await createStore({ enableVector: true, enableFts: false });
  });

  afterEach(() => {
    store.close();
  });

  it("vector search is available", () => {
    expect(store.isVectorAvailable()).toBe(true);
  });

  it("finds similar embeddings", () => {
    const emb1 = makeEmbedding(4, 1);
    const emb2 = makeEmbedding(4, 2);
    const emb3 = makeEmbedding(4, 100); // very different

    store.insert(makeChunk({ content: "similar to query" }), emb1);
    store.insert(makeChunk({ content: "somewhat similar" }), emb2);
    store.insert(makeChunk({ content: "very different" }), emb3);

    // Query with something close to emb1
    const queryEmb = makeEmbedding(4, 1.1); // close to seed=1
    const results = store.semanticSearch(queryEmb);

    expect(results.length).toBeGreaterThanOrEqual(1);
    // The closest should be "similar to query"
    expect(results[0].chunk.content).toBe("similar to query");
  });

  it("returns scores between 0 and 1", () => {
    store.insert(makeChunk({ content: "test" }), makeEmbedding(4, 1));

    const results = store.semanticSearch(makeEmbedding(4, 1));
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("respects filters in vector search", () => {
    store.insert(makeChunk({ content: "Alice memory", person: "Alice" }), makeEmbedding(4, 1));
    store.insert(makeChunk({ content: "Bob memory", person: "Bob" }), makeEmbedding(4, 1.1));

    const results = store.semanticSearch(makeEmbedding(4, 1), { person: "Alice" });
    expect(results.every((r) => r.chunk.person === "Alice")).toBe(true);
  });

  it("updates embedding on chunk update", () => {
    const id = store.insert(makeChunk({ content: "original" }), makeEmbedding(4, 1));

    // Update with a very different embedding
    store.update(id, { content: "updated" }, makeEmbedding(4, 50));

    // Query with the new embedding — should find it
    const results = store.semanticSearch(makeEmbedding(4, 50));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunk.content).toBe("updated");
  });

  it("removes embedding on delete", () => {
    const emb = makeEmbedding(4, 42);
    const id = store.insert(makeChunk({ content: "deletable" }), emb);

    store.delete(id);

    const results = store.semanticSearch(emb);
    expect(results.some((r) => r.chunk.content === "deletable")).toBe(false);
  });
});

describe("MemoryStore — Hybrid Search", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await createStore({ enableVector: true, enableFts: true });
  });

  afterEach(() => {
    store.close();
  });

  it("combines vector and FTS results", () => {
    // This chunk matches both semantically and by keyword
    store.insert(makeChunk({ content: "TypeScript memory system design" }), makeEmbedding(4, 1));
    // This one only matches by text
    store.insert(makeChunk({ content: "TypeScript is a typed language" }));
    // This one only matches by vector (similar embedding, different text)
    store.insert(makeChunk({ content: "programming paradigms overview" }), makeEmbedding(4, 1.05));

    const results = store.hybridSearch("TypeScript", makeEmbedding(4, 1));
    expect(results.length).toBeGreaterThanOrEqual(1);

    // The chunk that matches both should rank highest
    expect(results[0].chunk.content).toBe("TypeScript memory system design");
  });

  it("works when only FTS has results", () => {
    store.insert(makeChunk({ content: "unique keyword xylophone" }));

    // Use a random embedding that won't match anything well
    const results = store.hybridSearch("xylophone", makeEmbedding(4, 999));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunk.content).toBe("unique keyword xylophone");
  });
});

describe("MemoryStore — Tier Operations", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await createStore({ enableVector: false, enableFts: false });
  });

  afterEach(() => {
    store.close();
  });

  it("getByTier returns only matching tier", () => {
    store.insert(makeChunk({ tier: "working", content: "w1" }));
    store.insert(makeChunk({ tier: "working", content: "w2" }));
    store.insert(makeChunk({ tier: "short_term", content: "st1" }));
    store.insert(makeChunk({ tier: "long_term", content: "lt1" }));

    const working = store.getByTier("working");
    expect(working.length).toBe(2);
    expect(working.every((c) => c.tier === "working")).toBe(true);
  });

  it("getByTier respects pagination", () => {
    for (let i = 0; i < 10; i++) {
      store.insert(makeChunk({ tier: "episodic", content: `ep${i}` }));
    }

    const page1 = store.getByTier("episodic", { limit: 3, offset: 0 });
    const page2 = store.getByTier("episodic", { limit: 3, offset: 3 });

    expect(page1.length).toBe(3);
    expect(page2.length).toBe(3);
    // No overlap
    const ids1 = new Set(page1.map((c) => c.id));
    expect(page2.every((c) => !ids1.has(c.id))).toBe(true);
  });

  it("promote changes tier and sets promotedAt", () => {
    const id = store.insert(makeChunk({ tier: "short_term" }));
    store.promote(id, "long_term");

    const chunk = store.get(id)!;
    expect(chunk.tier).toBe("long_term");
    expect(chunk.promotedAt).toBeDefined();
    expect(chunk.promotedAt!).toBeGreaterThan(0);
  });

  it("promote throws for non-existent id", () => {
    expect(() => store.promote("nope", "long_term")).toThrow(/not found/);
  });

  it("decay moves chunks to lower tier", () => {
    // Insert chunks with old timestamps
    const oldTime = Date.now() - 86400_000; // 24 hours ago
    store.insert(
      makeChunk({ tier: "working", content: "old1", createdAt: oldTime, updatedAt: oldTime }),
    );
    store.insert(
      makeChunk({ tier: "working", content: "old2", createdAt: oldTime, updatedAt: oldTime }),
    );
    store.insert(makeChunk({ tier: "working", content: "fresh" })); // recent

    const cutoff = new Date(Date.now() - 3600_000); // 1 hour ago
    const count = store.decay(cutoff, "working", "short_term");

    expect(count).toBe(2);

    // Old chunks should now be short_term
    const working = store.getByTier("working");
    expect(working.length).toBe(1);
    expect(working[0].content).toBe("fresh");

    const shortTerm = store.getByTier("short_term");
    expect(shortTerm.length).toBe(2);
  });

  it("decay with null toTier deletes chunks", () => {
    const oldTime = Date.now() - 86400_000;
    store.insert(
      makeChunk({
        tier: "working",
        content: "ephemeral",
        createdAt: oldTime,
        updatedAt: oldTime,
      }),
    );

    const cutoff = new Date(Date.now() - 3600_000);
    const count = store.decay(cutoff, "working", null);

    expect(count).toBe(1);
    expect(store.getByTier("working").length).toBe(0);
  });

  it("deleteExpired removes expired chunks", () => {
    store.insert(makeChunk({ content: "alive" }));
    store.insert(makeChunk({ content: "expired", expiresAt: Date.now() - 1000 }));
    store.insert(makeChunk({ content: "future", expiresAt: Date.now() + 86400_000 }));

    const count = store.deleteExpired();
    expect(count).toBe(1);

    // 2 remaining
    const s = store.stats();
    expect(s.totalChunks).toBe(2);
  });
});

describe("MemoryStore — Person Scoped", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await createStore({ enableVector: false, enableFts: false });
  });

  afterEach(() => {
    store.close();
  });

  it("getByPerson returns only that person's chunks", () => {
    store.insert(makeChunk({ content: "Alice note 1", person: "Alice" }));
    store.insert(makeChunk({ content: "Alice note 2", person: "Alice" }));
    store.insert(makeChunk({ content: "Bob note", person: "Bob" }));
    store.insert(makeChunk({ content: "No person" }));

    const aliceChunks = store.getByPerson("Alice");
    expect(aliceChunks.length).toBe(2);
    expect(aliceChunks.every((c) => c.person === "Alice")).toBe(true);
  });

  it("getByPerson returns empty for unknown person", () => {
    store.insert(makeChunk({ content: "something", person: "Alice" }));
    const results = store.getByPerson("Charlie");
    expect(results.length).toBe(0);
  });
});

describe("MemoryStore — Stats", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await createStore({ enableVector: false, enableFts: false });
  });

  afterEach(() => {
    store.close();
  });

  it("returns correct aggregate stats", () => {
    store.insert(makeChunk({ tier: "working", category: "fact", person: "Alice" }));
    store.insert(makeChunk({ tier: "working", category: "fact", person: "Bob" }));
    store.insert(makeChunk({ tier: "short_term", category: "decision" }));
    store.insert(makeChunk({ tier: "long_term", category: "lesson", person: "Alice" }));

    const s = store.stats();
    expect(s.totalChunks).toBe(4);
    expect(s.byTier.working).toBe(2);
    expect(s.byTier.short_term).toBe(1);
    expect(s.byTier.long_term).toBe(1);
    expect(s.byTier.episodic).toBe(0);
    expect(s.byCategory["fact"]).toBe(2);
    expect(s.byCategory["decision"]).toBe(1);
    expect(s.byCategory["lesson"]).toBe(1);
    expect(s.byPerson["Alice"]).toBe(2);
    expect(s.byPerson["Bob"]).toBe(1);
    expect(s.oldestChunk).not.toBeNull();
    expect(s.newestChunk).not.toBeNull();
    expect(s.dbSizeBytes).toBeGreaterThan(0);
  });

  it("returns zeroes for empty store", () => {
    const s = store.stats();
    expect(s.totalChunks).toBe(0);
    expect(s.byTier.working).toBe(0);
    expect(s.oldestChunk).toBeNull();
    expect(s.newestChunk).toBeNull();
  });
});

describe("MemoryStore — Lifecycle", () => {
  it("throws after close", async () => {
    const store = await createStore();
    store.close();
    expect(() => store.get("x")).toThrow(/closed/);
  });

  it("close is idempotent", async () => {
    const store = await createStore();
    store.close();
    store.close(); // no error
  });
});
