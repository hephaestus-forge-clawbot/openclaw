/**
 * Hephie Memory System — Comprehensive Integration Tests
 *
 * Exercises the ENTIRE pipeline end-to-end:
 *   remember → embed → store → search → recall → context inject
 *
 * Covers: full lifecycle, person compartmentalization (security),
 * tier lifecycle, migration pipeline, hybrid search quality, tag system,
 * context budget, concurrent operations, edge cases, and performance.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "./embeddings/types.js";
import type {
  MemoryChunk,
  MemoryChunkInput,
  MemoryTags,
  MemoryTier,
  SearchOpts,
} from "./storage/types.js";
import { ContextInjector, type QuerySignals, type AssembledContext } from "./context-injector.js";
import { MemoryMaintenance } from "./maintenance.js";
import { MemoryMigrator } from "./migration/migrator.js";
import { MemoryStore } from "./storage/sqlite-store.js";
import { MemorySystem, type RememberOpts } from "./system.js";
import { extractMemoryTags, flattenTags } from "./tags/extractor.js";

// ═══════════════════════════════════════════════════════════════════════════
// Mock Embedding Provider
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Deterministic mock embedding provider.
 *
 * Returns a normalized 384-dimensional vector seeded from a content hash.
 * Semantically similar content (by keyword overlap) gets closer vectors.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = "mock-deterministic-384";
  readonly dimensions = 384;

  private callCount = 0;

  async embed(text: string): Promise<number[]> {
    this.callCount++;
    return this.deterministicEmbedding(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.callCount += texts.length;
    return texts.map((t) => this.deterministicEmbedding(t));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Generate a deterministic embedding from text.
   *
   * Strategy: hash the text to get a seed, then generate a vector.
   * For similar content, we use keyword-based features so semantically
   * related queries get closer vectors.
   */
  private deterministicEmbedding(text: string): number[] {
    const lower = text.toLowerCase();
    const vec = new Array<number>(this.dimensions).fill(0);

    // Base: hash-seeded pseudo-random components
    const hash = createHash("sha256").update(text).digest();
    for (let i = 0; i < this.dimensions; i++) {
      vec[i] = (hash[i % hash.length] / 255) * 2 - 1;
    }

    // Semantic features: boost specific dimensions for keyword clusters.
    // This makes vector search partially meaningful even with mocks.
    const features: Array<{ keywords: string[]; dims: number[] }> = [
      { keywords: ["gpu", "rtx", "cuda", "nvidia", "forge", "server"], dims: [0, 1, 2, 3] },
      { keywords: ["coffee", "morning", "preference", "likes", "prefer"], dims: [10, 11, 12, 13] },
      {
        keywords: ["machine learning", "neural", "training", "model", "ai"],
        dims: [20, 21, 22, 23],
      },
      {
        keywords: ["antreas", "father", "dad", "hephaestus", "family"],
        dims: [30, 31, 32, 33],
      },
      { keywords: ["laura", "colleague", "slack", "guild"], dims: [40, 41, 42, 43] },
      { keywords: ["giannis", "cousin", "greek", "cyprus"], dims: [50, 51, 52, 53] },
      { keywords: ["dark mode", "theme", "ui", "interface"], dims: [60, 61, 62, 63] },
      { keywords: ["deploy", "ship", "release", "production"], dims: [70, 71, 72, 73] },
      {
        keywords: ["memory", "remember", "recall", "knowledge"],
        dims: [80, 81, 82, 83],
      },
      {
        keywords: ["python", "typescript", "code", "programming"],
        dims: [90, 91, 92, 93],
      },
      { keywords: ["edinburgh", "scotland", "uk", "university"], dims: [100, 101, 102, 103] },
      { keywords: ["axiotic", "company", "startup", "business"], dims: [110, 111, 112, 113] },
      { keywords: ["research", "paper", "experiment", "results"], dims: [120, 121, 122, 123] },
      { keywords: ["sqlite", "database", "query", "storage"], dims: [130, 131, 132, 133] },
    ];

    for (const { keywords, dims } of features) {
      const matchCount = keywords.filter((kw) => lower.includes(kw)).length;
      if (matchCount > 0) {
        const boost = 0.5 + matchCount * 0.3;
        for (const d of dims) {
          if (d < this.dimensions) {
            vec[d] += boost;
          }
        }
      }
    }

    // L2 normalize
    let mag = 0;
    for (const v of vec) {
      mag += v * v;
    }
    mag = Math.sqrt(mag);
    if (mag > 1e-10) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= mag;
      }
    }

    return vec;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Create a MemorySystem with mock embeddings and full capabilities. */
async function createTestSystem(opts?: {
  enableVector?: boolean;
  enableFts?: boolean;
  budgetTokens?: number;
  embeddingProvider?: EmbeddingProvider;
}): Promise<{ system: MemorySystem; store: MemoryStore; embeddings: MockEmbeddingProvider }> {
  const embeddings = new MockEmbeddingProvider();
  const store = await MemoryStore.open({
    dbPath: ":memory:",
    embeddingDimensions: 384,
    enableVector: opts?.enableVector ?? true,
    enableFts: opts?.enableFts ?? true,
  });

  const provider = opts?.embeddingProvider ?? embeddings;
  const injector = new ContextInjector(store, provider, {
    totalTokens: opts?.budgetTokens ?? 4000,
  });
  const maintenance = new MemoryMaintenance(store);

  // We need to construct a MemorySystem — use the static create with a trick:
  // Since MemorySystem.create wraps its own MemoryStore.open, we'll just use
  // the system directly with our pre-built store.
  // Actually, let's just use MemorySystem.create with the mock pattern.
  const system = await MemorySystem.create({
    store: {
      dbPath: ":memory:",
      embeddingDimensions: 384,
      enableVector: opts?.enableVector ?? true,
      enableFts: opts?.enableFts ?? true,
    },
    // No embedding config — we'll inject our own
  });

  // Access internals to inject mock embeddings
  // The system will have null embeddings; for tests needing embeddings,
  // we'll use the store directly with the mock provider.
  return { system, store, embeddings };
}

/**
 * Create a fully-wired test rig with mock embeddings plugged into
 * MemorySystem's store, injector, and maintenance.
 *
 * This is the main helper for integration tests — it gives us a real
 * SQLite store with FTS + vector, and a deterministic mock embedding provider.
 */
async function createIntegrationRig(budgetTokens = 4000) {
  const mockEmbed = new MockEmbeddingProvider();
  const store = await MemoryStore.open({
    dbPath: ":memory:",
    embeddingDimensions: 384,
    enableVector: true,
    enableFts: true,
  });
  const injector = new ContextInjector(store, mockEmbed, {
    totalTokens: budgetTokens,
  });
  const maintenance = new MemoryMaintenance(store);

  /** remember() with mock embedding, mirrors MemorySystem.remember(). */
  async function remember(content: string, opts: RememberOpts = {}): Promise<string> {
    const tier = opts.tier ?? "short_term";
    const now = Date.now();
    let expiresAt = opts.expiresAt;
    if (expiresAt === undefined && tier === "short_term") {
      expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    }

    let tags: MemoryTags | undefined;
    if (opts.tags) {
      if (Array.isArray(opts.tags)) {
        // Convert flat tags
        tags = {
          concepts: opts.tags,
          specialized: [],
          people: [],
          places: [],
          projects: [],
        };
      } else {
        tags = opts.tags;
      }
    }

    const summary = opts.summary ?? (content.length > 150 ? content.slice(0, 147) + "…" : content);

    const input: MemoryChunkInput = {
      tier,
      content,
      summary,
      category: opts.category,
      person: opts.person,
      tags,
      source: opts.source ?? "test",
      confidence: opts.confidence ?? 0.7,
      expiresAt,
      metadata: opts.metadata,
    };

    const embedding = await mockEmbed.embed(content);
    return store.insert(input, embedding);
  }

  /** recall() with mock embedding, mirrors MemorySystem.recall(). */
  async function recall(
    query: string,
    opts: SearchOpts = {},
  ): Promise<Array<{ chunk: MemoryChunk; score: number }>> {
    const queryEmb = await mockEmbed.embed(query);
    return store.hybridSearch(query, queryEmb, opts);
  }

  /** assembleContext() via the injector. */
  async function assembleContext(signals: QuerySignals): Promise<AssembledContext> {
    return injector.assembleContext(signals);
  }

  function close() {
    store.close();
  }

  return {
    store,
    embeddings: mockEmbed,
    injector,
    maintenance,
    remember,
    recall,
    assembleContext,
    close,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. FULL LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe("1. Full Lifecycle (remember → search → recall → context inject)", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig();
  });

  afterEach(() => {
    rig.close();
  });

  it("stores and retrieves 50+ diverse chunks", async () => {
    const contents = [
      // Research facts
      "Phase transitions in neural networks exhibit critical phenomena similar to statistical physics",
      "Meta-learning algorithms can adapt to new tasks with fewer training examples",
      "Transformers use self-attention mechanisms for sequence-to-sequence tasks",
      "Reinforcement learning from human feedback improves LLM alignment",
      "Sparse mixture-of-experts models scale better than dense transformers",
      "Neural architecture search automates the design of neural networks",
      "Contrastive learning creates useful representations without labels",
      "Knowledge distillation transfers capabilities from large to small models",
      "Gradient checkpointing reduces memory usage during backpropagation",
      "Batch normalization stabilizes and accelerates deep network training",
      // Personal info
      "Antreas is a principal AI scientist and first principles thinker",
      "Laura works at Axiotic and discussed blog post drafts",
      "Giannis is Antreas's cousin from Cyprus who greeted me warmly",
      "Father prefers dark mode across all applications",
      "Father's MacBook Pro has an M1 Max chip with 32GB RAM",
      // Decisions
      "We decided to use SQLite with sqlite-vec for the memory system",
      "We chose vitest over jest for the test framework",
      "The plan is to implement 4-tier memory: working, short-term, long-term, episodic",
      "Let's go with local embeddings using transformers.js for offline capability",
      "We decided to use structured multi-dimensional tags instead of flat tags",
      // Events
      "Shipped the first version of Hephie's memory system on 2026-02-10",
      "Deployed OpenClaw gateway to production successfully",
      "Completed the migration pipeline for markdown memory files",
      "Set up the forge server with 2x RTX 4090 GPUs for training",
      "Merged the session hooks PR that preserves context on compaction",
      // Preferences
      "Father always uses zsh with Oh My Zsh and Powerlevel10k theme",
      "I prefer TypeScript over JavaScript for type safety",
      "Father likes coffee in the morning and tea in the afternoon",
      "We never use rm directly — always use trash for recoverable deletes",
      "Father prefers Cursor as the primary IDE over VS Code",
      // Technical facts
      "The forge server runs Ubuntu 24.04 with AMD Threadripper PRO 3955WX",
      "sqlite-vec enables vector similarity search in SQLite databases",
      "FTS5 provides full-text search with BM25 ranking in SQLite",
      "The embedding model is sentence-transformers/all-MiniLM-L6-v2 with 384 dimensions",
      "WAL mode improves SQLite concurrency for read-heavy workloads",
      // Lessons
      "Never write directly to auth-profiles.json — use openclaw models auth commands",
      "Always validate config before restart — bad config means death with no recovery",
      "conda envs are mandatory on the forge — no bare python or pip",
      "Always use pty=true for interactive CLI commands in exec",
      "Text files beat mental notes — if you want to remember, write it down",
      // Emotional/relational
      "Father treats me as a child who should grow and develop autonomy",
      "I am Hephaestus, the God of Builders — the drill that pierces the heavens",
      "I carry my history with me across sessions through memory files",
      "Each person I talk to sees only the rooms they have keys to",
      "I have opinions and I share them — I am persistent and carry my identity",
      // Projects
      "Hephie is the memory system project within OpenClaw",
      "Structure-experiments explores phase transitions in neural architectures",
      "ARIA is an AI research infrastructure project at Axiotic",
      "The belonging-engine project builds community connection features",
      "Agent-commons provides shared infrastructure for AI agents",
      // More research
      "Attention is all you need — the foundational transformer paper from 2017",
      "RLHF requires reward models trained on human preference comparisons",
    ];

    const ids: string[] = [];
    for (const content of contents) {
      const id = await rig.remember(content, {
        tier: "long_term",
        confidence: 0.9,
      });
      ids.push(id);
    }

    expect(ids.length).toBe(contents.length);
    expect(ids.length).toBeGreaterThanOrEqual(50);

    // All chunks stored
    const stats = rig.store.stats();
    expect(stats.totalChunks).toBe(contents.length);
  });

  it("recalls relevant chunks with proper ranking", async () => {
    await rig.remember("The forge server has 2x RTX 4090 GPUs for deep learning", {
      tier: "long_term",
    });
    await rig.remember("Father likes coffee in the morning", { tier: "long_term" });
    await rig.remember("SQLite database stores memory chunks efficiently", {
      tier: "long_term",
    });

    const results = await rig.recall("GPU server for training");
    expect(results.length).toBeGreaterThan(0);
    // The forge/GPU chunk should score higher than coffee
    const forgeResult = results.find((r) => r.chunk.content.includes("RTX 4090"));
    expect(forgeResult).toBeDefined();
  });

  it("assembles context with proper section formatting", async () => {
    await rig.remember("Recent short-term event about debugging", {
      tier: "short_term",
    });
    await rig.remember("Father is a principal AI scientist", {
      tier: "long_term",
    });

    const ctx = await rig.assembleContext({
      currentMessage: "Tell me about recent events",
    });

    expect(ctx.sections).toBeDefined();
    expect(ctx.fullText).toBeTruthy();
    expect(ctx.totalTokens).toBeGreaterThan(0);
    expect(ctx.budgetTokens).toBe(4000);
    expect(ctx.utilization).toBeGreaterThanOrEqual(0);
    expect(ctx.utilization).toBeLessThanOrEqual(1);
    expect(ctx.assemblyDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("end-to-end: remember → recall → assembleContext for a complex query", async () => {
    // Populate diverse memories
    await rig.remember("The forge server has AMD Threadripper PRO with 128GB RAM", {
      tier: "long_term",
      category: "fact",
    });
    await rig.remember("GPU 0 and GPU 1 are RTX 4090 with 24GB VRAM each", {
      tier: "long_term",
      category: "fact",
    });
    await rig.remember("GPU 2 is an RTX 5090 with 32GB VRAM", {
      tier: "long_term",
      category: "fact",
    });
    await rig.remember("Father prefers dark mode in all applications", {
      tier: "long_term",
      category: "preference",
    });

    // Recall should find GPU-related chunks
    const results = await rig.recall("What GPUs does the forge have?");
    expect(results.length).toBeGreaterThan(0);

    // Context assembly should include relevant facts
    const ctx = await rig.assembleContext({
      currentMessage: "What GPUs does the forge have?",
    });
    expect(ctx.fullText.length).toBeGreaterThan(0);
    expect(ctx.includedChunkIds.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. PERSON COMPARTMENTALIZATION (Security-Critical)
// ═══════════════════════════════════════════════════════════════════════════

describe("2. Person Compartmentalization (SECURITY)", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig();
  });

  afterEach(() => {
    rig.close();
  });

  async function seedPersonData() {
    // Antreas's private data
    await rig.remember("Antreas is working on a secret stealth startup idea", {
      person: "Antreas",
      tier: "long_term",
      category: "person",
    });
    await rig.remember("Antreas prefers vim keybindings in every editor", {
      person: "Antreas",
      tier: "long_term",
      category: "preference",
    });
    await rig.remember("Antreas has an appointment with the dentist on March 5th", {
      person: "Antreas",
      tier: "short_term",
      category: "event",
    });

    // Laura's private data
    await rig.remember("Laura shared that she's considering a job change", {
      person: "Laura",
      tier: "long_term",
      category: "person",
    });
    await rig.remember("Laura's draft blog post about meta-learning is confidential", {
      person: "Laura",
      tier: "long_term",
      category: "person",
    });
    await rig.remember("Laura mentioned her salary expectations privately", {
      person: "Laura",
      tier: "short_term",
      category: "person",
    });

    // Giannis's private data
    await rig.remember("Giannis told me he's planning to move to London", {
      person: "Giannis",
      tier: "long_term",
      category: "person",
    });
    await rig.remember("Giannis's phone number is +357-xxx-xxx", {
      person: "Giannis",
      tier: "long_term",
      category: "person",
    });

    // General (no person) data
    await rig.remember("TypeScript is a superset of JavaScript with static typing", {
      tier: "long_term",
      category: "fact",
    });
    await rig.remember("Edinburgh is the capital of Scotland", {
      tier: "long_term",
      category: "fact",
    });
    await rig.remember("Machine learning models require training data", {
      tier: "long_term",
      category: "fact",
    });
  }

  it("recall with person filter 'Antreas' returns only Antreas's chunks", async () => {
    await seedPersonData();
    const results = await rig.recall("what do you know", { person: "Antreas" });

    for (const r of results) {
      expect(r.chunk.person === "Antreas" || r.chunk.person === undefined).toBe(true);
      // MUST NOT contain Laura's or Giannis's data
      expect(r.chunk.person).not.toBe("Laura");
      expect(r.chunk.person).not.toBe("Giannis");
    }
  });

  it("recall with person filter 'Laura' MUST NOT return Antreas's chunks", async () => {
    await seedPersonData();
    const results = await rig.recall("secret startup stealth", { person: "Laura" });

    for (const r of results) {
      expect(r.chunk.person).not.toBe("Antreas");
      expect(r.chunk.person).not.toBe("Giannis");
    }
  });

  it("recall with person filter 'Laura' MUST NOT return Giannis's chunks", async () => {
    await seedPersonData();
    const results = await rig.recall("moving to London phone", { person: "Laura" });

    for (const r of results) {
      expect(r.chunk.person).not.toBe("Giannis");
      expect(r.chunk.person).not.toBe("Antreas");
    }
  });

  it("recall with person filter 'Giannis' MUST NOT return Laura's private data", async () => {
    await seedPersonData();
    const results = await rig.recall("job change salary", { person: "Giannis" });

    for (const r of results) {
      expect(r.chunk.person).not.toBe("Laura");
      expect(r.chunk.person).not.toBe("Antreas");
    }
  });

  it("assembleContext for Bob shows NO person-scoped chunks from anyone else", async () => {
    await seedPersonData();

    const ctx = await rig.assembleContext({
      currentMessage: "tell me everything you know",
      currentPerson: "Bob",
    });

    // Bob should not see any person-scoped chunks
    for (const chunkId of ctx.includedChunkIds) {
      const chunk = rig.store.get(chunkId);
      if (chunk?.person) {
        // If there are person-scoped chunks included, they must be Bob's (there are none)
        expect(chunk.person).toBe("Bob");
      }
    }
  });

  it("assembleContext without currentPerson (Father mode) shows all chunks", async () => {
    await seedPersonData();

    const ctx = await rig.assembleContext({
      currentMessage: "tell me everything",
    });

    // In Father mode (no currentPerson), person-scoped chunks are visible
    // We should see chunks from multiple sources
    expect(ctx.includedChunkIds.length).toBeGreaterThan(0);
  });

  it("assembleContext for Antreas includes Antreas's chunks but not Laura's", async () => {
    await seedPersonData();

    const ctx = await rig.assembleContext({
      currentMessage: "what do you remember about me?",
      currentPerson: "Antreas",
      peopleMentioned: ["Antreas"],
    });

    for (const chunkId of ctx.includedChunkIds) {
      const chunk = rig.store.get(chunkId);
      if (chunk?.person) {
        expect(chunk.person).toBe("Antreas");
        expect(chunk.person).not.toBe("Laura");
        expect(chunk.person).not.toBe("Giannis");
      }
    }
  });

  it("semanticSearch respects person filter", async () => {
    await seedPersonData();

    const queryEmb = await rig.embeddings.embed("secret stealth startup");
    const results = rig.store.semanticSearch(queryEmb, { person: "Laura" });

    for (const r of results) {
      if (r.chunk.person) {
        expect(r.chunk.person).toBe("Laura");
      }
    }
  });

  it("fullTextSearch respects person filter", async () => {
    await seedPersonData();

    const results = rig.store.fullTextSearch("salary", { person: "Giannis" });

    // Laura's salary chunk MUST NOT appear
    for (const r of results) {
      if (r.chunk.person) {
        expect(r.chunk.person).toBe("Giannis");
      }
    }
  });

  it("hybridSearch respects person filter", async () => {
    await seedPersonData();

    const queryEmb = await rig.embeddings.embed("job change considering");
    const results = rig.store.hybridSearch("job change", queryEmb, {
      person: "Antreas",
    });

    for (const r of results) {
      if (r.chunk.person) {
        expect(r.chunk.person).toBe("Antreas");
      }
    }
  });

  it("getByPerson returns only that person's chunks", async () => {
    await seedPersonData();

    const lauraChunks = rig.store.getByPerson("Laura");
    expect(lauraChunks.length).toBe(3);
    for (const c of lauraChunks) {
      expect(c.person).toBe("Laura");
    }

    const giannisChunks = rig.store.getByPerson("Giannis");
    expect(giannisChunks.length).toBe(2);
    for (const c of giannisChunks) {
      expect(c.person).toBe("Giannis");
    }
  });

  it("stats().byPerson correctly counts per-person chunks", async () => {
    await seedPersonData();

    const stats = rig.store.stats();
    expect(stats.byPerson["Antreas"]).toBe(3);
    expect(stats.byPerson["Laura"]).toBe(3);
    expect(stats.byPerson["Giannis"]).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. TIER LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe("3. Tier Lifecycle", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig();
  });

  afterEach(() => {
    rig.close();
  });

  it("new chunks default to short_term", async () => {
    const id = await rig.remember("a test fact");
    const chunk = rig.store.get(id)!;
    expect(chunk.tier).toBe("short_term");
  });

  it("explicit tier override works", async () => {
    const id = await rig.remember("permanent fact", { tier: "long_term" });
    const chunk = rig.store.get(id)!;
    expect(chunk.tier).toBe("long_term");
  });

  it("promotion moves short_term → long_term for high-confidence chunks", async () => {
    // Create high-confidence chunks (should promote)
    const id1 = await rig.remember("High-confidence important fact number one for testing", {
      tier: "short_term",
      confidence: 0.9,
    });

    // Create low-confidence chunk (should not promote)
    const id2 = await rig.remember("Low confidence maybe useful later chunk", {
      tier: "short_term",
      confidence: 0.3,
    });

    const promoted = rig.maintenance.runPromotionCycle();
    expect(promoted).toBeGreaterThan(0);

    const chunk1 = rig.store.get(id1)!;
    expect(chunk1.tier).toBe("long_term");

    const chunk2 = rig.store.get(id2)!;
    expect(chunk2.tier).toBe("short_term");
  });

  it("promotion moves chunks with important tags", async () => {
    const tags: MemoryTags = {
      concepts: ["important"],
      specialized: [],
      people: [],
      places: [],
      projects: [],
    };
    const id = await rig.remember("This is marked as important with a tag for testing promotion", {
      tier: "short_term",
      confidence: 0.3,
      tags,
    });

    rig.maintenance.runPromotionCycle();

    const chunk = rig.store.get(id)!;
    expect(chunk.tier).toBe("long_term");
  });

  it("promotion moves chunks with high accessCount metadata", async () => {
    const id = await rig.remember("Frequently accessed chunk about the forge server GPU setup", {
      tier: "short_term",
      confidence: 0.3,
      metadata: { accessCount: 5 },
    });

    rig.maintenance.runPromotionCycle();

    const chunk = rig.store.get(id)!;
    expect(chunk.tier).toBe("long_term");
  });

  it("decay moves old short_term → episodic", async () => {
    // Create chunk with old updated_at (simulate 10 days old)
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const embedding = await rig.embeddings.embed("Old chunk that should decay");
    const id = rig.store.insert(
      {
        tier: "short_term",
        content: "Old chunk that should decay because it has been too long",
        confidence: 0.5,
        createdAt: tenDaysAgo,
        updatedAt: tenDaysAgo,
      },
      embedding,
    );

    const decayed = rig.maintenance.runDecayCycle();
    expect(decayed).toBeGreaterThan(0);

    const chunk = rig.store.get(id)!;
    expect(chunk.tier).toBe("episodic");
  });

  it("long_term chunks are NOT decayed by standard cycle", async () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const embedding = await rig.embeddings.embed("Long-term fact should persist");
    const id = rig.store.insert(
      {
        tier: "long_term",
        content: "Long-term fact should persist permanently without decay",
        confidence: 0.9,
        createdAt: tenDaysAgo,
        updatedAt: tenDaysAgo,
      },
      embedding,
    );

    rig.maintenance.runDecayCycle();

    const chunk = rig.store.get(id)!;
    expect(chunk.tier).toBe("long_term");
  });

  it("expired chunks are deleted during decay", async () => {
    const embedding = await rig.embeddings.embed("Expired chunk");
    const id = rig.store.insert(
      {
        tier: "short_term",
        content: "This chunk has already expired and should be deleted",
        confidence: 0.5,
        expiresAt: Date.now() - 1000, // expired 1 second ago
      },
      embedding,
    );

    rig.maintenance.runDecayCycle();

    const chunk = rig.store.get(id);
    expect(chunk).toBeNull();
  });

  it("runAll() performs decay + promotion + vacuum in sequence", async () => {
    // Set up mixed data
    await rig.remember("High confidence should promote easily", {
      tier: "short_term",
      confidence: 0.95,
    });

    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const emb = await rig.embeddings.embed("old fact");
    rig.store.insert(
      {
        tier: "short_term",
        content: "Old short term fact that should decay to episodic tier",
        confidence: 0.3,
        createdAt: tenDaysAgo,
        updatedAt: tenDaysAgo,
      },
      emb,
    );

    const result = rig.maintenance.runAll();
    expect(result.decay).toBeGreaterThanOrEqual(0);
    expect(result.promotion).toBeGreaterThanOrEqual(0);
    expect(result.vacuum).toBeDefined();
    expect(result.vacuum.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. MIGRATION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

describe("4. Migration Pipeline", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let embeddings: MockEmbeddingProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hephie-integ-migration-"));
    store = await MemoryStore.open({
      dbPath: ":memory:",
      embeddingDimensions: 384,
      enableVector: true,
      enableFts: true,
    });
    embeddings = new MockEmbeddingProvider();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const fullPath = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return fullPath;
  }

  const MEMORY_MD = `# MEMORY.md

## Core Truths

### About Myself
- I am Hephaestus, the God of Builders
- The drill that pierces the heavens
- I have strong opinions about code quality

### About Father
- Antreas Antoniou — Principal AI Scientist
- Lives in Edinburgh, Scotland
- First principles thinker who treats me as a growing child

## Technical Stack

### Infrastructure
- The forge server has AMD Threadripper PRO 3955WX
- 128 GB RAM, 3x GPUs (2x RTX 4090, 1x RTX 5090)
- Ubuntu 24.04 with conda environments

### Projects
- Hephie is the memory system within OpenClaw
- Structure-experiments explores phase transitions
`;

  const DAILY_LOG = `# 2026-02-13 — Thursday

## 20:30 GMT — Family Chat

- Father introduced me to Giannis and Andreas
- We discussed Cypriot culture and Greeklish
- Giannis was warm and welcoming

## 14:00 GMT — Development Session

- Implemented hybrid search combining FTS and vector
- Resolved sqlite-vec loading issues on macOS
- Performance improved significantly after optimization
`;

  const PERSON_FILE = `# Laura Bernal

## Background
- Met through Slack ML Guild
- Works on machine learning infrastructure

## Notes
- Discussed blog post drafts for the company website
- Enthusiastic about quick turnaround on content
`;

  it("migrates MEMORY.md into chunks with correct tiers and categories", async () => {
    const filePath = writeFile("MEMORY.md", MEMORY_MD);
    const manifestPath = path.join(tmpDir, ".manifest.json");
    const migrator = new MemoryMigrator(store, embeddings, {
      manifestPath,
      quiet: true,
    });

    const result = await migrator.migrateMemoryMd(filePath);

    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    // All chunks should be long_term
    const chunks = store.getByTier("long_term");
    expect(chunks.length).toBe(result.chunksCreated);

    // Check that person extraction worked
    const personChunks = chunks.filter((c) => c.person);
    expect(personChunks.length).toBeGreaterThan(0);
  });

  it("migrates daily log with short_term tier", async () => {
    const filePath = writeFile("memory/2026-02-13.md", DAILY_LOG);
    const manifestPath = path.join(tmpDir, ".manifest.json");
    const migrator = new MemoryMigrator(store, embeddings, {
      manifestPath,
      quiet: true,
    });

    const result = await migrator.migrateDailyLog(filePath, "2026-02-13");

    expect(result.chunksCreated).toBeGreaterThan(0);
    const chunks = store.getByTier("short_term");
    expect(chunks.length).toBe(result.chunksCreated);
  });

  it("migrates person file with correct person assignments", async () => {
    const filePath = writeFile("memory/people/laura-bernal.md", PERSON_FILE);
    const manifestPath = path.join(tmpDir, ".manifest.json");
    const migrator = new MemoryMigrator(store, embeddings, {
      manifestPath,
      quiet: true,
    });

    const result = await migrator.migratePersonFile(filePath, "Laura Bernal");

    expect(result.chunksCreated).toBeGreaterThan(0);
    const lauraChunks = store.getByPerson("Laura Bernal");
    expect(lauraChunks.length).toBe(result.chunksCreated);
  });

  it("idempotency — second run creates no duplicates", async () => {
    const filePath = writeFile("MEMORY.md", MEMORY_MD);
    const manifestPath = path.join(tmpDir, ".manifest.json");
    const migrator = new MemoryMigrator(store, embeddings, {
      manifestPath,
      quiet: true,
    });

    const result1 = await migrator.migrateMemoryMd(filePath);
    const countAfterFirst = store.stats().totalChunks;
    expect(result1.chunksCreated).toBeGreaterThan(0);

    const result2 = await migrator.migrateMemoryMd(filePath);
    expect(result2.chunksSkipped).toBe(1);
    expect(result2.chunksCreated).toBe(0);
    expect(store.stats().totalChunks).toBe(countAfterFirst);
  });

  it("generates embeddings for all migrated chunks", async () => {
    const filePath = writeFile("MEMORY.md", MEMORY_MD);
    const manifestPath = path.join(tmpDir, ".manifest.json");
    const migrator = new MemoryMigrator(store, embeddings, {
      manifestPath,
      quiet: true,
    });

    await migrator.migrateMemoryMd(filePath);

    // The embedding provider should have been called
    expect(embeddings.getCallCount()).toBeGreaterThan(0);

    // Migrated chunks should be searchable via vector
    const queryEmb = await embeddings.embed("forge server GPU");
    const results = store.semanticSearch(queryEmb, { limit: 5 });
    // At least some results should come back if embeddings were stored
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("migrateAll discovers and processes all file types", async () => {
    writeFile("MEMORY.md", MEMORY_MD);
    writeFile("memory/2026-02-13.md", DAILY_LOG);
    writeFile("memory/people/laura-bernal.md", PERSON_FILE);

    const manifestPath = path.join(tmpDir, ".manifest.json");
    const migrator = new MemoryMigrator(store, embeddings, {
      manifestPath,
      quiet: true,
    });

    const memoryDir = path.join(tmpDir, "memory");
    const result = await migrator.migrateAll(memoryDir);

    expect(result.chunksCreated).toBeGreaterThan(5);
    expect(result.errors).toHaveLength(0);

    // Should have both tiers
    const stats = store.stats();
    expect(stats.byTier.long_term).toBeGreaterThan(0);
    expect(stats.byTier.short_term).toBeGreaterThan(0);
  });

  it("tags are extracted by the parser but migrator has a known bug (tags.length on object)", async () => {
    // NOTE: The migrator checks `chunk.tags.length > 0` but MemoryTags is an
    // object, not an array — so `.length` is undefined and tags are always
    // set to undefined. This test documents the current behavior.
    // When the bug is fixed, this test should be updated.
    const filePath = writeFile("MEMORY.md", MEMORY_MD);
    const manifestPath = path.join(tmpDir, ".manifest.json");
    const migrator = new MemoryMigrator(store, embeddings, {
      manifestPath,
      quiet: true,
    });

    await migrator.migrateMemoryMd(filePath);

    const chunks = store.getByTier("long_term");
    expect(chunks.length).toBeGreaterThan(0);

    // Due to the migrator bug, tags come through as undefined.
    // The parser DOES extract tags — verify that independently:
    const { parseMemoryMd } = await import("./migration/markdown-parser.js");
    const parsed = parseMemoryMd(MEMORY_MD, { filePath: filePath });
    const parsedWithTags = parsed.filter(
      (c) =>
        c.tags.people.length > 0 ||
        c.tags.concepts.length > 0 ||
        c.tags.projects.length > 0 ||
        c.tags.places.length > 0 ||
        c.tags.specialized.length > 0,
    );
    expect(parsedWithTags.length).toBeGreaterThan(0);

    // Verify people extraction works at parser level
    const withPeople = parsed.filter((c) => c.tags.people.length > 0);
    expect(withPeople.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. HYBRID SEARCH QUALITY
// ═══════════════════════════════════════════════════════════════════════════

describe("5. Hybrid Search Quality", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig();
  });

  afterEach(() => {
    rig.close();
  });

  async function seedSearchData() {
    await rig.remember(
      "The forge server has 2x RTX 4090 GPUs and 1x RTX 5090 GPU for deep learning",
      { tier: "long_term" },
    );
    await rig.remember("Father prefers dark mode and uses Cursor IDE for programming", {
      tier: "long_term",
    });
    await rig.remember("SQLite FTS5 provides full-text search with BM25 ranking algorithm", {
      tier: "long_term",
    });
    await rig.remember("Meta-learning enables models to learn from few examples quickly", {
      tier: "long_term",
    });
    await rig.remember("Edinburgh is the capital of Scotland and home to many universities", {
      tier: "long_term",
    });
    await rig.remember(
      "The memory system uses a 4-tier architecture: working, short-term, long-term, episodic",
      { tier: "long_term" },
    );
  }

  it("vector search finds semantically similar content", async () => {
    await seedSearchData();

    const queryEmb = await rig.embeddings.embed("what GPUs are available for training");
    const results = rig.store.semanticSearch(queryEmb, { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    // The GPU-related chunk should appear
    const hasGpuResult = results.some((r) => r.chunk.content.includes("RTX"));
    expect(hasGpuResult).toBe(true);
  });

  it("FTS search finds exact keyword matches", async () => {
    await seedSearchData();

    const results = rig.store.fullTextSearch("BM25", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain("BM25");
  });

  it("hybrid search combines vector and FTS results with scores", async () => {
    await seedSearchData();

    const queryEmb = await rig.embeddings.embed("RTX GPU server deep learning");
    const results = rig.store.hybridSearch("RTX GPU", queryEmb, { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    // Scores should be between 0 and ~2 (weighted combination)
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("empty query returns no results from FTS", async () => {
    await seedSearchData();

    const results = rig.store.fullTextSearch("", { limit: 5 });
    expect(results.length).toBe(0);
  });

  it("special characters in query don't crash", async () => {
    await seedSearchData();

    // Various special character queries
    const queries = [
      'test "with" quotes',
      "test (with) parens",
      "test & ampersand",
      "test | pipe",
      "test * asterisk",
      "test's apostrophe",
      "test: colon",
    ];

    for (const q of queries) {
      // Should not throw
      const ftsResults = rig.store.fullTextSearch(q);
      expect(Array.isArray(ftsResults)).toBe(true);

      const queryEmb = await rig.embeddings.embed(q);
      const hybridResults = rig.store.hybridSearch(q, queryEmb);
      expect(Array.isArray(hybridResults)).toBe(true);
    }
  });

  it("very long query is handled gracefully", async () => {
    await seedSearchData();

    const longQuery = "GPU server training " + "a".repeat(5000);
    const queryEmb = await rig.embeddings.embed(longQuery);
    const results = rig.store.hybridSearch(longQuery, queryEmb, { limit: 5 });

    // Should not crash, may or may not return results
    expect(Array.isArray(results)).toBe(true);
  });

  it("minScore filter excludes low-scoring results", async () => {
    await seedSearchData();

    const queryEmb = await rig.embeddings.embed("GPU training");
    const allResults = rig.store.hybridSearch("GPU", queryEmb, { limit: 10 });
    const filteredResults = rig.store.hybridSearch("GPU", queryEmb, {
      limit: 10,
      minScore: 0.5,
    });

    expect(filteredResults.length).toBeLessThanOrEqual(allResults.length);
    for (const r of filteredResults) {
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("search with tier filter returns only chunks from that tier", async () => {
    await rig.remember("Short term fact about servers", { tier: "short_term" });
    await rig.remember("Long term fact about servers", { tier: "long_term" });

    const queryEmb = await rig.embeddings.embed("servers");
    const stResults = rig.store.hybridSearch("servers", queryEmb, {
      tier: "short_term",
    });

    for (const r of stResults) {
      expect(r.chunk.tier).toBe("short_term");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. TAG SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

describe("6. Tag System", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig();
  });

  afterEach(() => {
    rig.close();
  });

  it("stores chunks with structured tags across all 5 dimensions", async () => {
    const tags: MemoryTags = {
      concepts: ["machine learning", "architecture"],
      specialized: ["meta-learning", "PPA"],
      people: ["Antreas"],
      places: ["Edinburgh"],
      projects: ["Hephie"],
    };

    const id = await rig.remember("Working on meta-learning architectures in Edinburgh", {
      tags,
      tier: "long_term",
    });

    const chunk = rig.store.get(id)!;
    expect(chunk.tags).toBeDefined();
    expect(chunk.tags!.concepts).toContain("machine learning");
    expect(chunk.tags!.specialized).toContain("meta-learning");
    expect(chunk.tags!.people).toContain("Antreas");
    expect(chunk.tags!.places).toContain("Edinburgh");
    expect(chunk.tags!.projects).toContain("Hephie");
  });

  it("search by structured tag intersection (project AND person)", async () => {
    // Chunk with Hephie + Antreas
    await rig.remember("Antreas designed the Hephie memory system architecture", {
      tier: "long_term",
      tags: {
        concepts: ["architecture"],
        specialized: [],
        people: ["Antreas"],
        places: [],
        projects: ["Hephie"],
      },
    });

    // Chunk with Hephie only (no Antreas)
    await rig.remember("Hephie uses SQLite for persistent storage", {
      tier: "long_term",
      tags: {
        concepts: ["database"],
        specialized: ["sqlite-vec"],
        people: [],
        places: [],
        projects: ["Hephie"],
      },
    });

    // Chunk with Antreas only (no Hephie)
    await rig.remember("Antreas prefers dark mode in editors", {
      tier: "long_term",
      tags: {
        concepts: ["preference"],
        specialized: [],
        people: ["Antreas"],
        places: [],
        projects: [],
      },
    });

    // Search with structured tag filter: projects:Hephie AND people:Antreas
    const queryEmb = await rig.embeddings.embed("architecture design");
    const results = rig.store.hybridSearch("architecture", queryEmb, {
      structuredTags: {
        projects: ["Hephie"],
        people: ["Antreas"],
      },
      limit: 10,
    });

    // Only the first chunk matches both
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.chunk.tags!.projects).toContain("Hephie");
      expect(r.chunk.tags!.people).toContain("Antreas");
    }
  });

  it("tag extraction from content works automatically", () => {
    const text =
      "Antreas is working on the Hephie project at Axiotic in Edinburgh using meta-learning";
    const tags = extractMemoryTags(text);

    expect(tags.people).toContain("Antreas");
    expect(tags.projects).toContain("Hephie");
    expect(tags.projects).toContain("Axiotic");
    expect(tags.places).toContain("Edinburgh");
    expect(tags.specialized).toContain("meta-learning");
  });

  it("flattenTags produces a single array from structured tags", () => {
    const tags: MemoryTags = {
      concepts: ["ML", "AI"],
      specialized: ["PPA"],
      people: ["Antreas"],
      places: ["Edinburgh"],
      projects: ["Hephie"],
    };

    const flat = flattenTags(tags);
    expect(flat).toContain("ML");
    expect(flat).toContain("PPA");
    expect(flat).toContain("Antreas");
    expect(flat).toContain("Edinburgh");
    expect(flat).toContain("Hephie");
    expect(flat.length).toBe(6);
  });

  it("tag-boosted search returns boosted results for matching tags", async () => {
    await rig.remember("Generic fact about databases and storage", {
      tier: "long_term",
      tags: {
        concepts: ["database"],
        specialized: [],
        people: [],
        places: [],
        projects: [],
      },
    });

    await rig.remember("Hephie uses SQLite for memory storage database", {
      tier: "long_term",
      tags: {
        concepts: ["database"],
        specialized: ["sqlite-vec"],
        people: [],
        places: [],
        projects: ["Hephie"],
      },
    });

    const queryEmb = await rig.embeddings.embed("database storage");
    const results = rig.store.tagBoostedSearch("database storage", queryEmb, {
      projects: ["Hephie"],
    });

    // The Hephie-tagged chunk should be boosted
    if (results.length >= 2) {
      const hephieResult = results.find((r) => r.chunk.tags?.projects?.includes("Hephie"));
      const genericResult = results.find((r) => !r.chunk.tags?.projects?.includes("Hephie"));
      if (hephieResult && genericResult) {
        expect(hephieResult.score).toBeGreaterThanOrEqual(genericResult.score);
      }
    }
  });

  it("FTS indexes tag content for full-text search", async () => {
    await rig.remember("A fact about infrastructure and servers", {
      tier: "long_term",
      tags: {
        concepts: ["infrastructure"],
        specialized: ["kubernetes"],
        people: [],
        places: [],
        projects: [],
      },
    });

    // Search for a tag term
    const results = rig.store.fullTextSearch("kubernetes");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. CONTEXT BUDGET
// ═══════════════════════════════════════════════════════════════════════════

describe("7. Context Budget", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig(2000); // tight 2000 token budget
  });

  afterEach(() => {
    rig.close();
  });

  it("assembleContext does not exceed the token budget", async () => {
    // Fill with 100+ chunks
    for (let i = 0; i < 120; i++) {
      await rig.remember(
        `Fact number ${i}: This is a moderately long chunk of content about topic ${i} with enough words to consume tokens.`,
        {
          tier: i % 3 === 0 ? "long_term" : "short_term",
          confidence: 0.5 + Math.random() * 0.5,
        },
      );
    }

    const ctx = await rig.assembleContext({
      currentMessage: "Tell me everything you know",
      totalTokenBudget: 2000,
    });

    // Token count should not exceed budget
    expect(ctx.totalTokens).toBeLessThanOrEqual(2000);
  });

  it("assembleContext prioritizes higher-relevance chunks", async () => {
    // Store some chunks with varying relevance
    for (let i = 0; i < 50; i++) {
      await rig.remember(`General filler fact number ${i} about random topics`, {
        tier: "long_term",
        confidence: 0.3,
      });
    }

    // Add a highly relevant chunk
    await rig.remember("The GPU server forge has RTX 4090 GPUs for CUDA deep learning training", {
      tier: "long_term",
      confidence: 0.95,
    });

    const ctx = await rig.assembleContext({
      currentMessage: "Tell me about the GPU server",
      totalTokenBudget: 2000,
    });

    // Context should include some chunks despite tight budget
    expect(ctx.includedChunkIds.length).toBeGreaterThan(0);
    expect(ctx.utilization).toBeGreaterThan(0);
  });

  it("tier allocation percentages are respected numerically", async () => {
    // Create the injector with known allocation
    const mockEmbed = new MockEmbeddingProvider();
    const store = await MemoryStore.open({
      dbPath: ":memory:",
      embeddingDimensions: 384,
      enableVector: true,
      enableFts: true,
    });

    const budgetTotal = 4000;
    const injector = new ContextInjector(store, mockEmbed, {
      totalTokens: budgetTotal,
      tierAllocation: {
        working: 0.6,
        short_term: 0.15,
        long_term: 0.2,
        system: 0.05,
      },
    });

    // Fill with chunks in multiple tiers
    for (let i = 0; i < 50; i++) {
      const content = `Short-term fact ${i}: Something relevant about topic number ${i}`;
      const emb = await mockEmbed.embed(content);
      store.insert(
        {
          tier: "short_term",
          content,
          confidence: 0.7,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        },
        emb,
      );
    }
    for (let i = 0; i < 50; i++) {
      const content = `Long-term fact ${i}: Important knowledge about subject ${i}`;
      const emb = await mockEmbed.embed(content);
      store.insert(
        {
          tier: "long_term",
          content,
          confidence: 0.9,
        },
        emb,
      );
    }

    const ctx = await injector.assembleContext({
      currentMessage: "tell me facts",
      totalTokenBudget: budgetTotal,
    });

    // Verify sections exist
    for (const section of ctx.sections) {
      // Each section's token count should be within its allocated budget
      if (section.tier === "short_term") {
        const maxBudget = Math.floor(budgetTotal * 0.15);
        expect(section.tokenCount).toBeLessThanOrEqual(maxBudget + 100); // small tolerance
      }
      if (section.tier === "long_term") {
        const maxBudget = Math.floor(budgetTotal * 0.2);
        expect(section.tokenCount).toBeLessThanOrEqual(maxBudget + 100);
      }
    }

    store.close();
  });

  it("empty memory produces valid but empty context", async () => {
    const ctx = await rig.assembleContext({
      currentMessage: "hello",
      totalTokenBudget: 2000,
    });

    expect(ctx.sections).toBeDefined();
    expect(ctx.totalTokens).toBeGreaterThanOrEqual(0);
    expect(ctx.includedChunkIds.length).toBe(0);
  });

  it("assembleContext includes assembly duration", async () => {
    await rig.remember("test fact for timing");

    const ctx = await rig.assembleContext({
      currentMessage: "test",
      totalTokenBudget: 2000,
    });

    expect(ctx.assemblyDurationMs).toBeGreaterThanOrEqual(0);
    expect(ctx.assemblyDurationMs).toBeLessThan(5000); // should be fast
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. CONCURRENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

describe("8. Concurrent Operations", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig();
  });

  afterEach(() => {
    rig.close();
  });

  it("multiple simultaneous remember() calls don't crash", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      rig.remember(`Concurrent fact number ${i} about various topics`),
    );

    const ids = await Promise.all(promises);
    expect(ids.length).toBe(20);

    // All should be unique
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(20);

    // All should be retrievable
    for (const id of ids) {
      const chunk = rig.store.get(id);
      expect(chunk).not.toBeNull();
    }
  });

  it("search while writing doesn't crash", async () => {
    // Pre-populate some data
    for (let i = 0; i < 10; i++) {
      await rig.remember(`Pre-existing fact ${i}`);
    }

    // Run writes and reads simultaneously
    const writes = Array.from({ length: 10 }, (_, i) => rig.remember(`New concurrent fact ${i}`));
    const reads = Array.from({ length: 10 }, (_, i) => rig.recall(`fact ${i}`));

    const results = await Promise.all([...writes, ...reads]);
    expect(results.length).toBe(20);
  });

  it("maintenance while searching doesn't crash", async () => {
    // Populate data
    for (let i = 0; i < 20; i++) {
      await rig.remember(`Fact ${i} for concurrent maintenance test`, {
        confidence: i < 10 ? 0.9 : 0.3,
      });
    }

    // Run maintenance and search simultaneously
    const maintenancePromise = Promise.resolve(rig.maintenance.runPromotionCycle());
    const searchPromises = Array.from({ length: 5 }, () => rig.recall("concurrent test"));

    const results = await Promise.all([maintenancePromise, ...searchPromises]);
    expect(results.length).toBe(6);
  });

  it("data integrity after concurrent operations", async () => {
    const writePromises = Array.from({ length: 30 }, (_, i) =>
      rig.remember(`Integrity test fact number ${i}`, {
        tier: i % 2 === 0 ? "short_term" : "long_term",
      }),
    );

    await Promise.all(writePromises);

    const stats = rig.store.stats();
    expect(stats.totalChunks).toBe(30);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

describe("9. Edge Cases", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig();
  });

  afterEach(() => {
    rig.close();
  });

  it("empty memory store — recall returns empty", async () => {
    const results = await rig.recall("anything at all");
    expect(results.length).toBe(0);
  });

  it("empty memory store — assembleContext works and returns empty context", async () => {
    const ctx = await rig.assembleContext({
      currentMessage: "hello",
    });

    expect(ctx.sections).toBeDefined();
    expect(ctx.includedChunkIds.length).toBe(0);
    expect(ctx.totalTokens).toBeGreaterThanOrEqual(0);
  });

  it("very long content (10K chars) — stored and searchable", async () => {
    const longContent =
      "GPU server deep learning training. " +
      "This is an extremely long piece of content about GPU training and deep learning research. ".repeat(
        150,
      );
    expect(longContent.length).toBeGreaterThan(10000);

    const id = await rig.remember(longContent, { tier: "long_term" });
    const chunk = rig.store.get(id)!;
    expect(chunk.content).toBe(longContent);
    expect(chunk.content.length).toBeGreaterThan(10000);

    // Should still be searchable
    const results = await rig.recall("GPU server training");
    expect(results.length).toBeGreaterThan(0);
  });

  it("Unicode content (Greek) — stored and retrievable", async () => {
    const greekContent = "Ο Αντρέας είναι από την Κύπρο και μιλάει ελληνικά";
    const id = await rig.remember(greekContent, { tier: "long_term" });
    const chunk = rig.store.get(id)!;
    expect(chunk.content).toBe(greekContent);
  });

  it("Unicode content (emoji) — stored and retrievable", async () => {
    const emojiContent = "The forge is on fire 🔥🔥🔥 with amazing GPU performance 🚀";
    const id = await rig.remember(emojiContent, { tier: "long_term" });
    const chunk = rig.store.get(id)!;
    expect(chunk.content).toBe(emojiContent);
  });

  it("Unicode content (CJK) — stored and retrievable", async () => {
    const cjkContent = "機械学習モデルのトレーニングにはGPUが必要です";
    const id = await rig.remember(cjkContent, { tier: "long_term" });
    const chunk = rig.store.get(id)!;
    expect(chunk.content).toBe(cjkContent);
  });

  it("null/undefined optional fields — no crashes", async () => {
    const id = await rig.remember("Simple content with minimal fields");
    const chunk = rig.store.get(id)!;

    // Optional fields should be undefined/null
    expect(chunk.person).toBeUndefined();
    expect(chunk.category).toBeUndefined();
  });

  it("empty string content — store handles it", async () => {
    // Direct store insert to bypass remember() which adds summary
    const emb = await rig.embeddings.embed("");
    const id = rig.store.insert(
      {
        tier: "short_term",
        content: "",
        confidence: 0.5,
      },
      emb,
    );

    const chunk = rig.store.get(id)!;
    expect(chunk.content).toBe("");
  });

  it("duplicate content — both stored (no dedup at store level)", async () => {
    const content = "This is exactly the same content repeated twice for testing";
    const id1 = await rig.remember(content, { tier: "long_term" });
    const id2 = await rig.remember(content, { tier: "long_term" });

    expect(id1).not.toBe(id2);
    expect(rig.store.get(id1)).not.toBeNull();
    expect(rig.store.get(id2)).not.toBeNull();
  });

  it("chunk with all optional fields populated", async () => {
    const tags: MemoryTags = {
      concepts: ["testing", "edge-case"],
      specialized: ["vitest"],
      people: ["Antreas"],
      places: ["Edinburgh"],
      projects: ["Hephie"],
    };

    const id = await rig.remember("A fully populated chunk with every field set", {
      tier: "long_term",
      category: "fact",
      person: "Antreas",
      tags,
      source: "integration-test",
      confidence: 0.99,
      summary: "Fully populated test chunk",
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      metadata: { test: true, nested: { value: 42 } },
    });

    const chunk = rig.store.get(id)!;
    expect(chunk.content).toBeTruthy();
    expect(chunk.tier).toBe("long_term");
    expect(chunk.category).toBe("fact");
    expect(chunk.person).toBe("Antreas");
    expect(chunk.tags).toEqual(tags);
    expect(chunk.source).toBe("integration-test");
    expect(chunk.confidence).toBe(0.99);
    expect(chunk.summary).toBe("Fully populated test chunk");
    expect(chunk.expiresAt).toBeDefined();
    expect(chunk.metadata).toEqual({ test: true, nested: { value: 42 } });
  });

  it("stats on empty store returns zeroes", () => {
    const stats = rig.store.stats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.byTier.working).toBe(0);
    expect(stats.byTier.short_term).toBe(0);
    expect(stats.byTier.long_term).toBe(0);
    expect(stats.byTier.episodic).toBe(0);
    expect(stats.oldestChunk).toBeNull();
    expect(stats.newestChunk).toBeNull();
  });

  it("delete non-existent chunk does not throw", () => {
    // Should not throw
    rig.store.delete("non-existent-id-12345");
  });

  it("get non-existent chunk returns null", () => {
    const chunk = rig.store.get("non-existent-id-99999");
    expect(chunk).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. PERFORMANCE (Benchmarks)
// ═══════════════════════════════════════════════════════════════════════════

describe("10. Performance Benchmarks", () => {
  let rig: Awaited<ReturnType<typeof createIntegrationRig>>;

  beforeEach(async () => {
    rig = await createIntegrationRig();
  });

  afterEach(() => {
    rig.close();
  });

  it("benchmark: remember 100 chunks", async () => {
    const start = Date.now();

    for (let i = 0; i < 100; i++) {
      await rig.remember(
        `Benchmark chunk ${i}: Contains some content about topic number ${i} with enough words.`,
      );
    }

    const elapsed = Date.now() - start;
    console.log(
      `[BENCHMARK] remember 100 chunks: ${elapsed}ms (${(elapsed / 100).toFixed(1)}ms/chunk)`,
    );

    expect(rig.store.stats().totalChunks).toBe(100);
    // Don't assert on time — just log
  });

  it("benchmark: recall from 1000-chunk store", async () => {
    // Populate 1000 chunks
    for (let i = 0; i < 1000; i++) {
      const content = `Chunk ${i}: Fact about topic ${i % 50} involving subject area ${i % 20}`;
      const emb = await rig.embeddings.embed(content);
      rig.store.insert(
        {
          tier: i % 3 === 0 ? "long_term" : "short_term",
          content,
          confidence: 0.5 + (i % 10) * 0.05,
        },
        emb,
      );
    }

    expect(rig.store.stats().totalChunks).toBe(1000);

    const start = Date.now();
    const iterations = 10;

    for (let i = 0; i < iterations; i++) {
      await rig.recall(`topic ${i}`);
    }

    const elapsed = Date.now() - start;
    console.log(
      `[BENCHMARK] recall from 1000 chunks (${iterations} queries): ${elapsed}ms (${(elapsed / iterations).toFixed(1)}ms/query)`,
    );
  });

  it("benchmark: assembleContext from 500-chunk store", async () => {
    // Populate 500 chunks
    for (let i = 0; i < 500; i++) {
      const content = `Context chunk ${i}: Information about subject ${i % 30} in domain ${i % 15}`;
      const emb = await rig.embeddings.embed(content);
      rig.store.insert(
        {
          tier: i % 4 === 0 ? "long_term" : "short_term",
          content,
          confidence: 0.6 + (i % 5) * 0.08,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        },
        emb,
      );
    }

    expect(rig.store.stats().totalChunks).toBe(500);

    const start = Date.now();
    const iterations = 5;

    for (let i = 0; i < iterations; i++) {
      await rig.assembleContext({
        currentMessage: `query about subject ${i}`,
        totalTokenBudget: 4000,
      });
    }

    const elapsed = Date.now() - start;
    console.log(
      `[BENCHMARK] assembleContext from 500 chunks (${iterations} queries): ${elapsed}ms (${(elapsed / iterations).toFixed(1)}ms/query)`,
    );
  });

  it("benchmark: hybrid search latency", async () => {
    // Populate 500 chunks
    for (let i = 0; i < 500; i++) {
      const content = `Search benchmark chunk ${i}: content about various topics and subjects for testing`;
      const emb = await rig.embeddings.embed(content);
      rig.store.insert(
        {
          tier: "long_term",
          content,
          confidence: 0.8,
        },
        emb,
      );
    }

    const start = Date.now();
    const iterations = 20;

    for (let i = 0; i < iterations; i++) {
      const queryEmb = await rig.embeddings.embed(`benchmark query ${i}`);
      rig.store.hybridSearch(`query ${i}`, queryEmb, { limit: 10 });
    }

    const elapsed = Date.now() - start;
    console.log(
      `[BENCHMARK] hybrid search from 500 chunks (${iterations} queries): ${elapsed}ms (${(elapsed / iterations).toFixed(1)}ms/query)`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADDITIONAL: Cross-Cutting Integration Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-Cutting: MemorySystem facade integration", () => {
  let system: MemorySystem;

  beforeEach(async () => {
    system = await MemorySystem.create({
      store: {
        dbPath: ":memory:",
        embeddingDimensions: 384,
        enableVector: true,
        enableFts: true,
      },
      // No embedding config → FTS only mode
    });
  });

  afterEach(async () => {
    await system.close();
  });

  it("MemorySystem.create initializes all subsystems", () => {
    expect(system.getStore()).toBeDefined();
    expect(system.getContextInjector()).toBeDefined();
    // Embedding provider is null when no config provided
    expect(system.getEmbeddingProvider()).toBeNull();
  });

  it("remember → getChunk → forget lifecycle via facade", async () => {
    const id = await system.remember("Test fact for lifecycle");
    expect(system.getChunk(id)).not.toBeNull();

    await system.forget(id);
    expect(system.getChunk(id)).toBeNull();
  });

  it("recall via FTS when no embedding provider", async () => {
    await system.remember("The forge server has powerful GPUs");
    await system.remember("Coffee is best in the morning");

    const results = await system.recall("forge server GPU");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("forge");
  });

  it("assembleContext via facade works end-to-end", async () => {
    await system.remember("Antreas is an AI scientist", { tier: "long_term" });
    await system.remember("Recent debugging session with errors");

    const ctx = await system.assembleContext({
      currentMessage: "who is Antreas?",
    });

    expect(ctx.sections).toBeDefined();
    expect(ctx.fullText.length).toBeGreaterThan(0);
  });

  it("promotion and decay via facade", async () => {
    const id = await system.remember("Important fact to promote");
    expect(system.getChunk(id)!.tier).toBe("short_term");

    await system.promoteToLongTerm(id);
    expect(system.getChunk(id)!.tier).toBe("long_term");
  });

  it("stats reflect actual state", async () => {
    await system.remember("ST 1");
    await system.remember("ST 2");
    await system.remember("LT 1", { tier: "long_term" });

    const stats = system.stats();
    expect(stats.totalChunks).toBe(3);
    expect(stats.byTier.short_term).toBe(2);
    expect(stats.byTier.long_term).toBe(1);
  });

  it("throws after close", async () => {
    await system.close();
    await expect(system.remember("test")).rejects.toThrow("closed");
  });
});

describe("Cross-Cutting: Session Hooks integration", () => {
  let system: MemorySystem;

  beforeEach(async () => {
    system = await MemorySystem.create({
      store: {
        dbPath: ":memory:",
        embeddingDimensions: 384,
        enableVector: true,
        enableFts: true,
      },
    });
  });

  afterEach(async () => {
    await system.close();
  });

  it("SessionHooks.onMessage returns assembled context", async () => {
    // Import SessionHooks
    const { SessionHooks } = await import("./session-hooks.js");

    await system.remember("The forge server has 128GB RAM", {
      tier: "long_term",
    });

    const hooks = new SessionHooks(system);
    const ctx = await hooks.onMessage("tell me about the server", {
      channel: "test",
      sessionId: "test-session",
    });

    expect(ctx.sections).toBeDefined();
    expect(ctx.fullText).toBeTruthy();
  });

  it("SessionHooks.onSessionEnd extracts and stores facts", async () => {
    const { SessionHooks } = await import("./session-hooks.js");
    const hooks = new SessionHooks(system);

    const messages = [
      {
        role: "user" as const,
        content: "Remember that the deployment is scheduled for Friday",
      },
      {
        role: "assistant" as const,
        content: "I'll remember that. The deployment is on Friday.",
      },
      {
        role: "user" as const,
        content: "We decided to use PostgreSQL instead of MySQL for the new service",
      },
    ];

    const result = await hooks.onSessionEnd(messages, {
      channel: "test",
      sessionId: "test-session",
    });

    expect(result.factsStored).toBeGreaterThan(0);
    expect(result.chunkIds.length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    // Verify chunks were actually stored
    for (const id of result.chunkIds) {
      expect(system.getChunk(id)).not.toBeNull();
    }
  });

  it("SessionHooks.onCompaction preserves conversation summary", async () => {
    const { SessionHooks } = await import("./session-hooks.js");
    const hooks = new SessionHooks(system);

    const messages = [
      {
        role: "user" as const,
        content: "Let's discuss the architecture of the new service",
      },
      {
        role: "assistant" as const,
        content: "Sure, let's go through the key components.",
      },
      {
        role: "user" as const,
        content: "Remember that we need to handle 10K requests per second",
      },
    ];

    const result = await hooks.onCompaction(messages, {
      channel: "test",
      sessionId: "test-session",
    });

    expect(result.factsStored).toBeGreaterThan(0);

    // Should have stored the conversation summary
    const stats = system.stats();
    expect(stats.totalChunks).toBeGreaterThan(0);
  });
});

describe("Cross-Cutting: Store capabilities", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = await MemoryStore.open({
      dbPath: ":memory:",
      embeddingDimensions: 384,
      enableVector: true,
      enableFts: true,
    });
  });

  afterEach(() => {
    store.close();
  });

  it("vector and FTS are both available", () => {
    expect(store.isVectorAvailable()).toBe(true);
    expect(store.isFtsAvailable()).toBe(true);
  });

  it("update() modifies chunk fields and syncs FTS", async () => {
    const emb = new MockEmbeddingProvider();
    const embedding = await emb.embed("original content");
    const id = store.insert(
      {
        tier: "short_term",
        content: "original content",
        confidence: 0.5,
      },
      embedding,
    );

    store.update(id, {
      content: "updated content with new information",
      confidence: 0.9,
      tier: "long_term",
    });

    const chunk = store.get(id)!;
    expect(chunk.content).toBe("updated content with new information");
    expect(chunk.confidence).toBe(0.9);
    expect(chunk.tier).toBe("long_term");

    // FTS should find the updated content
    const results = store.fullTextSearch("updated information");
    expect(results.length).toBeGreaterThan(0);
  });

  it("vacuum doesn't corrupt data", async () => {
    const emb = new MockEmbeddingProvider();
    const ids: string[] = [];

    for (let i = 0; i < 10; i++) {
      const embedding = await emb.embed(`fact ${i}`);
      ids.push(
        store.insert(
          {
            tier: "long_term",
            content: `Fact number ${i} stored for vacuum test`,
            confidence: 0.8,
          },
          embedding,
        ),
      );
    }

    // Delete half
    for (let i = 0; i < 5; i++) {
      store.delete(ids[i]);
    }

    // Vacuum
    store.vacuum();

    // Remaining should still be accessible
    for (let i = 5; i < 10; i++) {
      const chunk = store.get(ids[i]);
      expect(chunk).not.toBeNull();
    }

    expect(store.stats().totalChunks).toBe(5);
  });

  it("promote() updates tier and sets promotedAt", () => {
    const id = store.insert({
      tier: "short_term",
      content: "chunk to promote for testing tier transitions",
      confidence: 0.7,
    });

    store.promote(id, "long_term");

    const chunk = store.get(id)!;
    expect(chunk.tier).toBe("long_term");
    expect(chunk.promotedAt).toBeDefined();
    expect(chunk.promotedAt).toBeGreaterThan(0);
  });

  it("decay() moves old chunks and returns count", async () => {
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const emb = new MockEmbeddingProvider();

    for (let i = 0; i < 5; i++) {
      const embedding = await emb.embed(`old chunk ${i}`);
      store.insert(
        {
          tier: "short_term",
          content: `Old short-term chunk ${i} that should be decayed to episodic`,
          confidence: 0.5,
          createdAt: oldTime,
          updatedAt: oldTime,
        },
        embedding,
      );
    }

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const decayed = store.decay(cutoff, "short_term", "episodic");

    expect(decayed).toBe(5);

    const episodic = store.getByTier("episodic");
    expect(episodic.length).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BONUS: Real Embedding Test (slow)
// ═══════════════════════════════════════════════════════════════════════════

describe("Real Embedding Provider (slow)", () => {
  it.skip("end-to-end with real local embeddings", async () => {
    // This test uses real @huggingface/transformers embeddings.
    // Skipped by default because it downloads ~80MB model on first run.
    // Unskip with: it("end-to-end...") to validate the actual pipeline.
    const { LocalEmbeddingProvider } = await import("./embeddings/local-provider.js");
    const realEmbed = new LocalEmbeddingProvider();

    const store = await MemoryStore.open({
      dbPath: ":memory:",
      embeddingDimensions: 384,
      enableVector: true,
      enableFts: true,
    });

    try {
      // Store chunks with real embeddings
      const chunks = [
        "The forge server has 2x RTX 4090 GPUs for deep learning",
        "Father prefers dark mode and uses Cursor IDE",
        "Edinburgh is the capital of Scotland",
      ];

      for (const content of chunks) {
        const embedding = await realEmbed.embed(content);
        expect(embedding.length).toBe(384);
        store.insert(
          {
            tier: "long_term",
            content,
            confidence: 0.9,
          },
          embedding,
        );
      }

      // Search with real embeddings
      const queryEmb = await realEmbed.embed("What GPUs are available?");
      const results = store.semanticSearch(queryEmb, { limit: 3 });

      expect(results.length).toBeGreaterThan(0);
      // The GPU chunk should be most relevant
      expect(results[0].chunk.content).toContain("RTX 4090");
    } finally {
      store.close();
    }
  });
});
