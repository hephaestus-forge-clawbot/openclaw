/**
 * Tests for Session Hooks — fact extraction and memory integration.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionHooks,
  _extractFactsFromMessages,
  _extractConversationSummary,
  type ConversationMessage,
} from "./session-hooks.js";
import { MemorySystem } from "./system.js";

/** Helper: create an in-memory MemorySystem. */
async function createTestSystem() {
  return MemorySystem.create({
    store: {
      dbPath: ":memory:",
      embeddingDimensions: 4,
      enableVector: false,
      enableFts: true,
    },
  });
}

describe("Fact Extraction (heuristic)", () => {
  it("extracts explicit memory requests", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Remember that I prefer dark mode for all editors" },
    ];
    const facts = _extractFactsFromMessages(messages);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].content).toContain("prefer dark mode");
    expect(facts[0].confidence).toBeGreaterThan(0.7);
  });

  it("extracts decisions", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "We decided to use SQLite for the memory backend" },
    ];
    const facts = _extractFactsFromMessages(messages);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].category).toBe("decision");
    expect(facts[0].content).toContain("SQLite");
  });

  it("extracts preferences", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "I always use conda envs on the forge" },
    ];
    const facts = _extractFactsFromMessages(messages);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].category).toBe("preference");
  });

  it("extracts lessons", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Lesson: never write directly to auth-profiles.json" },
    ];
    const facts = _extractFactsFromMessages(messages);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].category).toBe("lesson");
  });

  it("deduplicates identical facts", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Remember that the server is at 192.168.50.146" },
      { role: "user", content: "Remember that the server is at 192.168.50.146" },
    ];
    const facts = _extractFactsFromMessages(messages);
    expect(facts.length).toBe(1);
  });

  it("skips system messages", () => {
    const messages: ConversationMessage[] = [
      { role: "system", content: "Remember that you are Hephaestus" },
    ];
    const facts = _extractFactsFromMessages(messages);
    expect(facts.length).toBe(0);
  });

  it("skips very short matches", () => {
    const messages: ConversationMessage[] = [{ role: "user", content: "Remember: ok" }];
    const facts = _extractFactsFromMessages(messages);
    // "ok" is too short (< 10 chars)
    expect(facts.length).toBe(0);
  });

  it("marks explicit requests as important", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Don't forget that the API key is in 1Password" },
    ];
    const facts = _extractFactsFromMessages(messages);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].important).toBe(true);
  });
});

describe("Conversation Summary", () => {
  it("extracts topics from user messages", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "How do I set up the forge?" },
      { role: "assistant", content: "SSH into the forge and..." },
      { role: "user", content: "What about the GPU configuration?" },
    ];
    const summary = _extractConversationSummary(messages);
    expect(summary).toContain("forge");
    expect(summary).toContain("GPU");
  });

  it("returns empty for no user messages", () => {
    const messages: ConversationMessage[] = [{ role: "system", content: "You are Hephaestus" }];
    const summary = _extractConversationSummary(messages);
    expect(summary).toBe("");
  });
});

describe("SessionHooks", () => {
  let system: MemorySystem;
  let hooks: SessionHooks;

  beforeEach(async () => {
    system = await createTestSystem();
    hooks = new SessionHooks(system);
  });

  afterEach(async () => {
    await system.close();
  });

  // ── onSessionEnd ────────────────────────────────────────────────────

  it("onSessionEnd extracts and stores facts", async () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Remember that the forge IP is 192.168.50.146" },
      { role: "assistant", content: "Got it, I'll remember that." },
      { role: "user", content: "We decided to use conda for everything on the forge" },
    ];

    const result = await hooks.onSessionEnd(messages);
    expect(result.factsStored).toBeGreaterThan(0);
    expect(result.chunkIds.length).toBe(result.factsStored);
    expect(result.errors).toHaveLength(0);

    // Verify chunks were actually stored
    const stats = system.stats();
    expect(stats.totalChunks).toBe(result.factsStored);
  });

  it("onSessionEnd stores important facts as long_term", async () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Remember that Father's email is antreas@example.com" },
    ];

    const result = await hooks.onSessionEnd(messages);
    expect(result.factsStored).toBeGreaterThan(0);

    // Important facts go to long_term
    const ltChunks = system.getByTier("long_term");
    expect(ltChunks.length).toBeGreaterThan(0);
  });

  it("onSessionEnd handles empty conversations", async () => {
    const result = await hooks.onSessionEnd([]);
    expect(result.factsStored).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── onCompaction ────────────────────────────────────────────────────

  it("onCompaction stores a conversation summary", async () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Let's set up the memory system" },
      { role: "assistant", content: "Sure, I'll create the SQLite store..." },
      { role: "user", content: "Great, now test the embeddings" },
    ];

    const result = await hooks.onCompaction(messages);
    expect(result.factsStored).toBeGreaterThan(0);

    // Should have a summary chunk
    const chunks = system.getByTier("short_term");
    const summaryChunk = chunks.find((c) => c.tags?.includes("session-summary"));
    expect(summaryChunk).toBeDefined();
  });

  // ── onMessage ───────────────────────────────────────────────────────

  it("onMessage returns assembled context", async () => {
    // Pre-populate some memory
    await system.remember("The forge has GPUs for training", { tier: "long_term" });

    const ctx = await hooks.onMessage("Tell me about the forge GPUs");
    expect(ctx.sections).toBeDefined();
    expect(ctx.fullText).toBeTruthy();
    expect(ctx.assemblyDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("onMessage with person context", async () => {
    await system.remember("Alice's project timeline", { person: "alice" });

    const ctx = await hooks.onMessage("What's the project timeline?", {
      person: "alice",
    });

    // Alice's chunks should be included
    const aliceChunks = system.getByPerson("alice");
    const included = ctx.includedChunkIds.some((id) => aliceChunks.some((c) => c.id === id));
    expect(included).toBe(true);
  });
});
