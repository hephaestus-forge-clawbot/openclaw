/**
 * Tests for the MemorySystem facade.
 *
 * Uses in-memory SQLite databases — no disk I/O, no embedding provider.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySystem } from "./system.js";

/** Helper: create an in-memory MemorySystem without embeddings. */
async function createTestSystem() {
  return MemorySystem.create({
    store: {
      dbPath: ":memory:",
      embeddingDimensions: 4,
      enableVector: false, // Skip vector for unit tests (no sqlite-vec in CI)
      enableFts: true,
    },
    // No embedding config — pure FTS mode
  });
}

describe("MemorySystem", () => {
  let system: MemorySystem;

  beforeEach(async () => {
    system = await createTestSystem();
  });

  afterEach(async () => {
    await system.close();
  });

  // ── remember & recall ───────────────────────────────────────────────

  it("remember() stores a chunk and returns an id", async () => {
    const id = await system.remember("Father prefers dark mode");
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("remember() stores with default short_term tier", async () => {
    const id = await system.remember("test fact");
    const chunk = system.getChunk(id);
    expect(chunk).not.toBeNull();
    expect(chunk!.tier).toBe("short_term");
  });

  it("remember() respects custom tier", async () => {
    const id = await system.remember("permanent fact", { tier: "long_term" });
    const chunk = system.getChunk(id);
    expect(chunk!.tier).toBe("long_term");
  });

  it("remember() auto-generates summary", async () => {
    const longContent = "A".repeat(300);
    const id = await system.remember(longContent);
    const chunk = system.getChunk(id);
    expect(chunk!.summary).toBeTruthy();
    expect(chunk!.summary!.length).toBeLessThan(longContent.length);
  });

  it("remember() sets expiry for short_term chunks", async () => {
    const id = await system.remember("temporary fact");
    const chunk = system.getChunk(id);
    expect(chunk!.expiresAt).toBeDefined();
    // Should be ~7 days from now
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(chunk!.expiresAt).toBeGreaterThan(Date.now());
    expect(chunk!.expiresAt).toBeLessThanOrEqual(Date.now() + sevenDaysMs + 1000);
  });

  it("remember() does NOT set expiry for long_term chunks", async () => {
    const id = await system.remember("permanent", { tier: "long_term" });
    const chunk = system.getChunk(id);
    expect(chunk!.expiresAt).toBeUndefined();
  });

  it("recall() finds stored chunks via FTS", async () => {
    await system.remember("The forge server has 2x RTX 4090 GPUs");
    await system.remember("Father likes coffee in the morning");

    const results = await system.recall("forge server GPU");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("forge");
  });

  it("recall() returns empty for no matches", async () => {
    await system.remember("hello world");
    const results = await system.recall("xyznonexistent");
    expect(results.length).toBe(0);
  });

  // ── forget ──────────────────────────────────────────────────────────

  it("forget() deletes a chunk", async () => {
    const id = await system.remember("to be deleted");
    expect(system.getChunk(id)).not.toBeNull();

    await system.forget(id);
    expect(system.getChunk(id)).toBeNull();
  });

  // ── promoteToLongTerm ───────────────────────────────────────────────

  it("promoteToLongTerm() moves a chunk to long_term", async () => {
    const id = await system.remember("important fact");
    expect(system.getChunk(id)!.tier).toBe("short_term");

    await system.promoteToLongTerm(id);
    expect(system.getChunk(id)!.tier).toBe("long_term");
  });

  it("promoteToLongTerm() throws for non-existent chunk", async () => {
    await expect(system.promoteToLongTerm("nonexistent")).rejects.toThrow();
  });

  // ── tier queries ────────────────────────────────────────────────────

  it("getByTier() returns chunks in the specified tier", async () => {
    await system.remember("st fact 1");
    await system.remember("st fact 2");
    await system.remember("lt fact", { tier: "long_term" });

    const stChunks = system.getByTier("short_term");
    expect(stChunks.length).toBe(2);

    const ltChunks = system.getByTier("long_term");
    expect(ltChunks.length).toBe(1);
  });

  // ── person queries ──────────────────────────────────────────────────

  it("getByPerson() returns person-scoped chunks", async () => {
    await system.remember("Alice works at Axiotic", { person: "alice" });
    await system.remember("Bob likes hiking", { person: "bob" });
    await system.remember("general fact");

    const aliceChunks = system.getByPerson("alice");
    expect(aliceChunks.length).toBe(1);
    expect(aliceChunks[0].person).toBe("alice");
  });

  // ── stats ───────────────────────────────────────────────────────────

  it("stats() returns aggregate statistics", async () => {
    await system.remember("fact 1");
    await system.remember("fact 2");
    await system.remember("fact 3", { tier: "long_term" });

    const stats = system.stats();
    expect(stats.totalChunks).toBe(3);
    expect(stats.byTier.short_term).toBe(2);
    expect(stats.byTier.long_term).toBe(1);
  });

  // ── assembleContext ─────────────────────────────────────────────────

  it("assembleContext() returns structured context", async () => {
    await system.remember("The forge server has 2x RTX 4090");
    await system.remember("Father is Antreas Antoniou", { tier: "long_term" });

    const ctx = await system.assembleContext({
      currentMessage: "Tell me about the forge server",
    });

    expect(ctx.sections).toBeDefined();
    expect(ctx.fullText).toBeTruthy();
    expect(ctx.totalTokens).toBeGreaterThan(0);
    expect(ctx.budgetTokens).toBeGreaterThan(0);
    expect(ctx.utilization).toBeGreaterThanOrEqual(0);
    expect(ctx.assemblyDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("assembleContext() respects compartmentalization", async () => {
    await system.remember("Alice's secret project", { person: "alice" });
    await system.remember("General fact about servers");

    // When talking to Bob, Alice's chunks should NOT appear
    const ctx = await system.assembleContext({
      currentMessage: "what do you know?",
      currentPerson: "bob",
    });

    expect(ctx.includedChunkIds).toBeDefined();
    // Alice's chunk should not be in the included IDs
    const aliceChunks = system.getByPerson("alice");
    for (const ac of aliceChunks) {
      expect(ctx.includedChunkIds).not.toContain(ac.id);
    }
  });

  // ── lifecycle ───────────────────────────────────────────────────────

  it("throws after close()", async () => {
    await system.close();
    await expect(system.remember("test")).rejects.toThrow("closed");
  });

  it("close() is idempotent", async () => {
    await system.close();
    await system.close(); // Should not throw
  });
});
