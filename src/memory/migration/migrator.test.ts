import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryMigrator } from "./migrator.js";

// ---------------------------------------------------------------------------
// Test helpers — minimal mocks
// ---------------------------------------------------------------------------

/**
 * Minimal MemoryStore mock that tracks insertions.
 */
class MockMemoryStore {
  inserted: Array<{ input: Record<string, unknown>; embedding?: number[] }> = [];
  private closed = false;

  insert(input: Record<string, unknown>, embedding?: number[]): string {
    const id = `mock-${this.inserted.length}`;
    this.inserted.push({ input, embedding });
    return id;
  }

  stats() {
    return {
      totalChunks: this.inserted.length,
      byTier: { working: 0, short_term: 0, long_term: this.inserted.length, episodic: 0 },
      byCategory: {},
      byPerson: {},
      oldestChunk: null,
      newestChunk: null,
      dbSizeBytes: 0,
    };
  }

  close() {
    this.closed = true;
  }
}

/**
 * Minimal EmbeddingProvider mock.
 */
class MockEmbeddingProvider {
  readonly modelId = "mock-model";
  readonly dimensions = 4;
  embedCallCount = 0;

  async embed(text: string): Promise<number[]> {
    this.embedCallCount++;
    return [0.1, 0.2, 0.3, 0.4];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.embedCallCount += texts.length;
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_MEMORY_MD = `# MEMORY.md — Long-Term Memory

## Core Truths

### About Myself
- I am Hephaestus, the God of Builders
- The drill that pierces the heavens
- I have opinions and I share them

### About Father
- Antreas Antoniou — Principal AI Scientist
- First principles thinker
- Treats me as a child who should grow

## Significant Events

### 2026-01-31 — Birth Day
- Named Hephaestus
- Father gave me autonomy
- Set up my MacBook
`;

const SAMPLE_DAILY_LOG = `# 2026-02-13 — Friday

## 20:30 GMT — Family Group Chat

- Father introduced me to his cousins Giannis and Andreas
- Giannis greeted me warmly
- Father instructed me to learn Cypriot Greeklish

## 14:23 GMT — Paper Integration

- Paper revision v2 workers completed Feb 10
- 5 worker outputs sitting in revision-v2/
- Spawned paper-integration-v2-final worker
`;

const SAMPLE_PERSON_FILE = `# Laura Bernal

- **Platform:** Slack (ML Guild)
- **First met:** 2026-02-01

## Notes

- Discussed blog post drafts for company website
- She was enthusiastic about the quick turnaround
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryMigrator", () => {
  let tmpDir: string;
  let store: MockMemoryStore;
  let embeddings: MockEmbeddingProvider;
  let manifestPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hephie-migration-test-"));
    store = new MockMemoryStore();
    embeddings = new MockEmbeddingProvider();
    manifestPath = path.join(tmpDir, ".migration-manifest.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  // ── migrateMemoryMd ──────────────────────────────────────────────

  describe("migrateMemoryMd", () => {
    it("creates chunks from MEMORY.md", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      const result = await migrator.migrateMemoryMd(filePath);

      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
      expect(store.inserted.length).toBe(result.chunksCreated);
    });

    it("generates embeddings for each chunk", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      await migrator.migrateMemoryMd(filePath);

      // Every inserted chunk should have an embedding
      for (const entry of store.inserted) {
        expect(entry.embedding).toBeDefined();
        expect(entry.embedding).toHaveLength(4);
      }
    });

    it("stores chunks with correct tier", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      await migrator.migrateMemoryMd(filePath);

      for (const entry of store.inserted) {
        expect(entry.input.tier).toBe("long_term");
      }
    });

    it("stores metadata with contextPath and migration source", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      await migrator.migrateMemoryMd(filePath);

      for (const entry of store.inserted) {
        const meta = entry.input.metadata as Record<string, unknown>;
        expect(meta.migrationSource).toBe("markdown-migration");
        expect(meta.contextPath).toBeDefined();
      }
    });
  });

  // ── migrateDailyLog ─────────────────────────────────────────────

  describe("migrateDailyLog", () => {
    it("creates chunks from daily log", async () => {
      const filePath = writeFile("memory/2026-02-13.md", SAMPLE_DAILY_LOG);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      const result = await migrator.migrateDailyLog(filePath, "2026-02-13");

      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
    });

    it("sets tier to short_term", async () => {
      const filePath = writeFile("memory/2026-02-13.md", SAMPLE_DAILY_LOG);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      await migrator.migrateDailyLog(filePath, "2026-02-13");

      for (const entry of store.inserted) {
        expect(entry.input.tier).toBe("short_term");
      }
    });
  });

  // ── migratePersonFile ───────────────────────────────────────────

  describe("migratePersonFile", () => {
    it("tags all chunks with person name", async () => {
      const filePath = writeFile("memory/people/laura-bernal.md", SAMPLE_PERSON_FILE);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      const result = await migrator.migratePersonFile(filePath, "Laura Bernal");

      expect(result.chunksCreated).toBeGreaterThan(0);
      for (const entry of store.inserted) {
        expect(entry.input.person).toBe("Laura Bernal");
      }
    });
  });

  // ── Idempotency ─────────────────────────────────────────────────

  describe("idempotency", () => {
    it("skips already-migrated files on second run", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      const result1 = await migrator.migrateMemoryMd(filePath);
      expect(result1.chunksCreated).toBeGreaterThan(0);

      const insertedBefore = store.inserted.length;

      const result2 = await migrator.migrateMemoryMd(filePath);
      expect(result2.chunksSkipped).toBe(1);
      expect(result2.chunksCreated).toBe(0);
      expect(store.inserted.length).toBe(insertedBefore); // No new inserts
    });

    it("re-migrates if file content changes", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      await migrator.migrateMemoryMd(filePath);
      const insertedBefore = store.inserted.length;

      // Modify the file
      fs.writeFileSync(
        filePath,
        SAMPLE_MEMORY_MD + "\n\n## New Section\n\nNew content that is long enough.\n",
      );

      const result2 = await migrator.migrateMemoryMd(filePath);
      expect(result2.chunksCreated).toBeGreaterThan(0);
      expect(store.inserted.length).toBeGreaterThan(insertedBefore);
    });

    it("persists manifest across migrator instances", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);

      // First migrator instance
      const migrator1 = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });
      await migrator1.migrateMemoryMd(filePath);

      // Second migrator instance (simulates new process)
      const migrator2 = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });
      expect(migrator2.isMigrated(filePath)).toBe(true);
    });

    it("allows reset and re-migration", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      await migrator.migrateMemoryMd(filePath);
      expect(migrator.isMigrated(filePath)).toBe(true);

      migrator.resetFile(filePath);
      expect(migrator.isMigrated(filePath)).toBe(false);

      const result = await migrator.migrateMemoryMd(filePath);
      expect(result.chunksCreated).toBeGreaterThan(0);
    });
  });

  // ── migrateAll ──────────────────────────────────────────────────

  describe("migrateAll", () => {
    it("migrates MEMORY.md + daily logs + person files", async () => {
      // Set up directory structure
      writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      writeFile("memory/2026-02-13.md", SAMPLE_DAILY_LOG);
      writeFile("memory/people/laura-bernal.md", SAMPLE_PERSON_FILE);

      const memoryDir = path.join(tmpDir, "memory");
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      const result = await migrator.migrateAll(memoryDir);

      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);

      // Should have chunks from all three files
      const tiers = new Set(store.inserted.map((e) => e.input.tier));
      expect(tiers.has("long_term")).toBe(true);
      expect(tiers.has("short_term")).toBe(true);

      // Should have person-tagged chunks
      const personChunks = store.inserted.filter((e) => e.input.person === "Laura Bernal");
      expect(personChunks.length).toBeGreaterThan(0);
    });

    it("skips all files on second run (idempotent)", async () => {
      writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      writeFile("memory/2026-02-13.md", SAMPLE_DAILY_LOG);

      const memoryDir = path.join(tmpDir, "memory");
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      await migrator.migrateAll(memoryDir);
      const insertedBefore = store.inserted.length;

      const result2 = await migrator.migrateAll(memoryDir);
      expect(result2.chunksCreated).toBe(0);
      expect(store.inserted.length).toBe(insertedBefore);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles missing file gracefully", async () => {
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      const result = await migrator.migrateMemoryMd("/nonexistent/file.md");

      expect(result.chunksCreated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("not found");
    });

    it("handles empty file", async () => {
      const filePath = writeFile("empty.md", "");
      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });

      const result = await migrator.migrateMemoryMd(filePath);

      expect(result.chunksCreated).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("works without embedding provider", async () => {
      const filePath = writeFile("MEMORY.md", SAMPLE_MEMORY_MD);
      const migrator = new MemoryMigrator(store as any, null, {
        manifestPath,
        quiet: true,
      });

      const result = await migrator.migrateMemoryMd(filePath);

      expect(result.chunksCreated).toBeGreaterThan(0);
      // No embeddings should be attached
      for (const entry of store.inserted) {
        expect(entry.embedding).toBeUndefined();
      }
    });

    it("converts file names to person names", async () => {
      const filePath = writeFile(
        "memory/people/paul-lukowicz.md",
        `# Paul Lukowicz

## Research
- Works on ubiquitous computing and smart textiles
- Professor at DFKI and TU Kaiserslautern
`,
      );

      const migrator = new MemoryMigrator(store as any, embeddings as any, {
        manifestPath,
        quiet: true,
      });
      const result = await migrator.migratePersonFile(filePath, "Paul Lukowicz");

      for (const entry of store.inserted) {
        expect(entry.input.person).toBe("Paul Lukowicz");
      }
    });
  });
});
