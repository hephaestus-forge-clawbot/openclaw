/**
 * Tests for the Context Injection Pipeline.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextInjector, type QuerySignals, type AssembledContext } from "./context-injector.js";
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

/** Helper: insert a chunk and return its id. */
function insertChunk(
  store: MemoryStore,
  content: string,
  opts: { tier?: string; person?: string; category?: string; tags?: string[] } = {},
): string {
  return store.insert({
    tier: (opts.tier as "short_term" | "long_term") ?? "short_term",
    content,
    summary: content.length > 100 ? content.slice(0, 100) + "…" : content,
    person: opts.person,
    category: opts.category,
    tags: opts.tags,
  });
}

describe("ContextInjector", () => {
  let store: MemoryStore;
  let injector: ContextInjector;

  beforeEach(async () => {
    store = await createStore();
    injector = new ContextInjector(store, null); // No embeddings for unit tests
  });

  afterEach(() => {
    store.close();
  });

  // ── assembleContext ─────────────────────────────────────────────────

  it("returns empty context when store is empty", async () => {
    const ctx = await injector.assembleContext({
      currentMessage: "hello",
    });

    expect(ctx.sections).toHaveLength(0);
    expect(ctx.fullText).toBe("");
    expect(ctx.totalTokens).toBe(0);
    expect(ctx.includedChunkIds).toHaveLength(0);
  });

  it("includes short-term chunks in context", async () => {
    insertChunk(store, "The forge server has 2x RTX 4090 GPUs", { tier: "short_term" });

    const ctx = await injector.assembleContext({
      currentMessage: "forge server GPU",
    });

    expect(ctx.sections.length).toBeGreaterThan(0);
    const stSection = ctx.sections.find((s) => s.tier === "short_term");
    expect(stSection).toBeDefined();
    expect(stSection!.content).toContain("forge");
  });

  it("includes long-term chunks in context", async () => {
    insertChunk(store, "Father is Antreas Antoniou, Principal AI Scientist", {
      tier: "long_term",
    });

    const ctx = await injector.assembleContext({
      currentMessage: "who is Father",
    });

    expect(ctx.sections.length).toBeGreaterThan(0);
    const ltSection = ctx.sections.find((s) => s.tier === "long_term");
    expect(ltSection).toBeDefined();
    expect(ltSection!.content).toContain("Antreas");
  });

  it("respects token budget", async () => {
    // Insert many chunks to potentially exceed budget
    for (let i = 0; i < 30; i++) {
      insertChunk(store, `Fact number ${i}: ${"x".repeat(200)}`, { tier: "long_term" });
    }

    const ctx = await injector.assembleContext({
      currentMessage: "Fact",
      totalTokenBudget: 200, // Very small budget
    });

    // Should not exceed the budget
    expect(ctx.totalTokens).toBeLessThanOrEqual(200);
  });

  // ── Compartmentalization ────────────────────────────────────────────

  it("filters out person-scoped chunks when talking to a different person", async () => {
    insertChunk(store, "Alice secret project details", {
      tier: "short_term",
      person: "alice",
    });
    insertChunk(store, "General server information", { tier: "short_term" });

    const ctx = await injector.assembleContext({
      currentMessage: "server project",
      currentPerson: "bob",
    });

    // Alice's chunk should not appear
    const allContent = ctx.fullText;
    expect(allContent).not.toContain("Alice secret");
  });

  it("shows person-scoped chunks when talking to that person", async () => {
    insertChunk(store, "Alice project details for reference", {
      tier: "short_term",
      person: "alice",
    });

    const ctx = await injector.assembleContext({
      currentMessage: "project details",
      currentPerson: "alice",
    });

    expect(ctx.fullText).toContain("Alice project");
  });

  it("shows all chunks in Father context (no currentPerson)", async () => {
    insertChunk(store, "Alice private info about her job", {
      tier: "short_term",
      person: "alice",
    });
    insertChunk(store, "General knowledge fact", { tier: "short_term" });

    const ctx = await injector.assembleContext({
      currentMessage: "info job knowledge",
    });

    expect(ctx.includedChunkIds.length).toBe(2);
  });

  // ── Person boosting ─────────────────────────────────────────────────

  it("boosts person-related chunks when person is mentioned", async () => {
    insertChunk(store, "Alice works at Axiotic AI as a researcher", {
      tier: "long_term",
      person: "alice",
    });
    insertChunk(store, "The weather is nice today", { tier: "long_term" });

    const ctx = await injector.assembleContext({
      currentMessage: "tell me about researchers",
      peopleMentioned: ["alice"],
    });

    // Alice's chunk should be boosted and appear
    const aliceChunks = store.getByPerson("alice");
    const aliceIncluded = ctx.includedChunkIds.some((id) => aliceChunks.some((c) => c.id === id));
    expect(aliceIncluded).toBe(true);
  });

  // ── Format ──────────────────────────────────────────────────────────

  it("formatChunk() produces readable output for short-term", () => {
    const chunk = store.get(
      insertChunk(store, "Discussed fork plan with Father", { tier: "short_term" }),
    )!;

    const formatted = injector.formatChunk(chunk);
    expect(formatted).toMatch(/^- \[.*\]/); // Should start with "- [time ago]"
    expect(formatted).toContain("fork plan");
  });

  it("formatChunk() produces readable output for long-term", () => {
    const chunk = store.get(
      insertChunk(store, "Father is Antreas Antoniou", { tier: "long_term" }),
    )!;

    const formatted = injector.formatChunk(chunk);
    expect(formatted).toBe("- Father is Antreas Antoniou");
  });

  // ── Token estimation ───────────────────────────────────────────────

  it("estimateTokens() returns reasonable estimates", () => {
    expect(injector.estimateTokens("hello")).toBe(2); // 5 chars / 4 ≈ 2
    expect(injector.estimateTokens("")).toBe(0);
    expect(injector.estimateTokens("a".repeat(100))).toBe(25);
  });

  // ── Section structure ──────────────────────────────────────────────

  it("sections have proper headers", async () => {
    insertChunk(store, "Recent event happened", { tier: "short_term" });
    insertChunk(store, "Known permanent fact", { tier: "long_term" });

    const ctx = await injector.assembleContext({
      currentMessage: "event fact",
    });

    const headers = ctx.sections.map((s) => s.header);
    if (ctx.sections.some((s) => s.tier === "short_term")) {
      expect(headers).toContain("## Recent Context (Short-Term Memory)");
    }
    if (ctx.sections.some((s) => s.tier === "long_term")) {
      expect(headers).toContain("## Known Facts (Long-Term Memory)");
    }
  });

  it("sections report excluded counts", async () => {
    // Insert more chunks than the default max (5 for short_term)
    for (let i = 0; i < 15; i++) {
      insertChunk(store, `Short term fact ${i} about testing things`, { tier: "short_term" });
    }

    const ctx = await injector.assembleContext({
      currentMessage: "fact testing things",
    });

    const stSection = ctx.sections.find((s) => s.tier === "short_term");
    if (stSection) {
      // Should have excluded some chunks
      expect(stSection.chunkIds.length).toBeLessThanOrEqual(5);
    }
  });

  // ── Assembly metadata ──────────────────────────────────────────────

  it("tracks assembly duration", async () => {
    const ctx = await injector.assembleContext({
      currentMessage: "test",
    });

    expect(ctx.assemblyDurationMs).toBeGreaterThanOrEqual(0);
    expect(ctx.assemblyDurationMs).toBeLessThan(5000); // Should be fast
  });

  it("tracks utilization ratio", async () => {
    insertChunk(store, "Some fact about servers and GPUs", { tier: "short_term" });

    const ctx = await injector.assembleContext({
      currentMessage: "servers GPUs",
      totalTokenBudget: 10000,
    });

    expect(ctx.utilization).toBeGreaterThanOrEqual(0);
    expect(ctx.utilization).toBeLessThanOrEqual(1);
  });
});
