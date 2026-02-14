/**
 * Tests for the Memory Maintenance module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMaintenance } from "./maintenance.js";
import { MemoryStore } from "./storage/sqlite-store.js";

/** Helper: create an in-memory store. */
async function createStore() {
  return MemoryStore.open({
    dbPath: ":memory:",
    embeddingDimensions: 4,
    enableVector: false,
    enableFts: true,
  });
}

describe("MemoryMaintenance — Decay Cycle", () => {
  let store: MemoryStore;
  let maintenance: MemoryMaintenance;

  beforeEach(async () => {
    store = await createStore();
    maintenance = new MemoryMaintenance(store, {
      shortTermRetentionDays: 7,
      logStats: false, // Quiet for tests
    });
  });

  afterEach(() => {
    store.close();
  });

  it("deletes expired chunks", () => {
    // Insert a chunk that's already expired
    store.insert({
      tier: "short_term",
      content: "expired fact",
      expiresAt: Date.now() - 1000, // 1 second ago
    });

    const affected = maintenance.runDecayCycle();
    expect(affected).toBe(1);
    expect(store.stats().totalChunks).toBe(0);
  });

  it("moves old short-term chunks to episodic", () => {
    // Insert a chunk from 8 days ago
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    store.insert({
      tier: "short_term",
      content: "old fact",
      updatedAt: eightDaysAgo,
    });

    const affected = maintenance.runDecayCycle();
    expect(affected).toBe(1);

    // Should now be episodic
    const episodic = store.getByTier("episodic");
    expect(episodic.length).toBe(1);
    expect(episodic[0].content).toBe("old fact");
  });

  it("does not decay recent short-term chunks", () => {
    store.insert({
      tier: "short_term",
      content: "recent fact",
      // Default updatedAt is now, so within retention
    });

    const affected = maintenance.runDecayCycle();
    expect(affected).toBe(0);

    const st = store.getByTier("short_term");
    expect(st.length).toBe(1);
  });

  it("handles empty store gracefully", () => {
    const affected = maintenance.runDecayCycle();
    expect(affected).toBe(0);
  });
});

describe("MemoryMaintenance — Promotion Cycle", () => {
  let store: MemoryStore;
  let maintenance: MemoryMaintenance;

  beforeEach(async () => {
    store = await createStore();
    maintenance = new MemoryMaintenance(store, {
      promotionConfidenceThreshold: 0.8,
      promotionMinAccessCount: 3,
      importantTags: ["important", "remember"],
      logStats: false,
    });
  });

  afterEach(() => {
    store.close();
  });

  it("promotes high-confidence chunks", () => {
    store.insert({
      tier: "short_term",
      content: "high confidence fact",
      confidence: 0.9,
    });

    const promoted = maintenance.runPromotionCycle();
    expect(promoted).toBe(1);

    const lt = store.getByTier("long_term");
    expect(lt.length).toBe(1);
    expect(lt[0].content).toBe("high confidence fact");
  });

  it("promotes chunks with important tags", () => {
    store.insert({
      tier: "short_term",
      content: "tagged important fact",
      confidence: 0.5, // Below threshold
      tags: ["important"],
    });

    const promoted = maintenance.runPromotionCycle();
    expect(promoted).toBe(1);
  });

  it("promotes chunks with high access count in metadata", () => {
    store.insert({
      tier: "short_term",
      content: "frequently accessed",
      confidence: 0.5,
      metadata: { accessCount: 5 },
    });

    const promoted = maintenance.runPromotionCycle();
    expect(promoted).toBe(1);
  });

  it("promotes chunks marked important in metadata", () => {
    store.insert({
      tier: "short_term",
      content: "metadata-important fact",
      confidence: 0.5,
      metadata: { important: true },
    });

    const promoted = maintenance.runPromotionCycle();
    expect(promoted).toBe(1);
  });

  it("does not promote low-confidence chunks without other criteria", () => {
    store.insert({
      tier: "short_term",
      content: "boring fact",
      confidence: 0.3,
    });

    const promoted = maintenance.runPromotionCycle();
    expect(promoted).toBe(0);

    const st = store.getByTier("short_term");
    expect(st.length).toBe(1);
  });

  it("handles empty store gracefully", () => {
    const promoted = maintenance.runPromotionCycle();
    expect(promoted).toBe(0);
  });

  it("only evaluates short_term chunks", () => {
    store.insert({
      tier: "working",
      content: "working memory fact",
      confidence: 0.95,
    });
    store.insert({
      tier: "episodic",
      content: "episodic event",
      confidence: 0.95,
    });

    const promoted = maintenance.runPromotionCycle();
    expect(promoted).toBe(0); // Neither should be touched
  });
});

describe("MemoryMaintenance — Vacuum", () => {
  let store: MemoryStore;
  let maintenance: MemoryMaintenance;

  beforeEach(async () => {
    store = await createStore();
    maintenance = new MemoryMaintenance(store, { logStats: false });
  });

  afterEach(() => {
    store.close();
  });

  it("runs vacuum without errors", () => {
    store.insert({ tier: "short_term", content: "test" });

    const result = maintenance.runVacuum();
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.details).toContain("Vacuumed");
  });

  it("cleans up expired chunks during vacuum", () => {
    store.insert({
      tier: "short_term",
      content: "expired",
      expiresAt: Date.now() - 1000,
    });
    store.insert({
      tier: "short_term",
      content: "still valid",
    });

    const result = maintenance.runVacuum();
    expect(result.affected).toBe(1);
    expect(store.stats().totalChunks).toBe(1);
  });
});

describe("MemoryMaintenance — runAll", () => {
  let store: MemoryStore;
  let maintenance: MemoryMaintenance;

  beforeEach(async () => {
    store = await createStore();
    maintenance = new MemoryMaintenance(store, { logStats: false });
  });

  afterEach(() => {
    store.close();
  });

  it("runs all maintenance tasks", () => {
    // Insert an expired chunk and a high-confidence chunk
    store.insert({
      tier: "short_term",
      content: "expired",
      expiresAt: Date.now() - 1000,
    });
    store.insert({
      tier: "short_term",
      content: "important",
      confidence: 0.95,
    });

    const result = maintenance.runAll();
    expect(result.decay).toBeGreaterThanOrEqual(1); // expired chunk
    expect(result.promotion).toBeGreaterThanOrEqual(1); // high confidence
    expect(result.vacuum.errors).toHaveLength(0);
  });
});
