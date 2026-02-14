/**
 * Memory migration runner.
 *
 * Reads markdown memory files, parses them into chunks, generates
 * embeddings, and stores everything in SQLite via MemoryStore.
 *
 * Idempotent — tracks which files have been migrated and skips them on
 * subsequent runs.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { MemoryStore } from "../storage/sqlite-store.js";
import type { ParsedChunk } from "./markdown-parser.js";
import { parseMemoryMd, parseDailyLog, parsePersonFile } from "./markdown-parser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationResult {
  chunksCreated: number;
  chunksSkipped: number;
  errors: string[];
  duration: number;
}

interface MigrationManifestEntry {
  filePath: string;
  hash: string;
  chunksCreated: number;
  migratedAt: number;
}

// ---------------------------------------------------------------------------
// Migrator
// ---------------------------------------------------------------------------

export class MemoryMigrator {
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingProvider | null;
  private readonly manifest = new Map<string, MigrationManifestEntry>();
  private readonly manifestPath: string | null;
  private quiet = false;

  constructor(
    store: MemoryStore,
    embeddings: EmbeddingProvider | null = null,
    opts?: { manifestPath?: string; quiet?: boolean },
  ) {
    this.store = store;
    this.embeddings = embeddings;
    this.manifestPath = opts?.manifestPath ?? null;
    this.quiet = opts?.quiet ?? false;
    this.loadManifest();
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Migrate MEMORY.md (long-term curated memory).
   */
  async migrateMemoryMd(filePath: string): Promise<MigrationResult> {
    return this.migrateFile(filePath, (content, fPath) =>
      parseMemoryMd(content, { filePath: fPath, tier: "long_term" }),
    );
  }

  /**
   * Migrate a daily log file.
   */
  async migrateDailyLog(filePath: string, date?: string): Promise<MigrationResult> {
    return this.migrateFile(filePath, (content, fPath) =>
      parseDailyLog(content, {
        filePath: fPath,
        tier: "short_term",
        createdAt: date ? new Date(date + "T00:00:00Z").getTime() : undefined,
      }),
    );
  }

  /**
   * Migrate a per-person notes file.
   */
  async migratePersonFile(filePath: string, personName: string): Promise<MigrationResult> {
    return this.migrateFile(filePath, (content, fPath) =>
      parsePersonFile(content, {
        filePath: fPath,
        tier: "long_term",
        person: personName,
      }),
    );
  }

  /**
   * Migrate all known memory files from a directory.
   *
   * Discovers:
   *  - MEMORY.md in the workspace root (parent of memoryDir)
   *  - memory/YYYY-MM-DD.md daily logs
   *  - memory/people/*.md person files
   *  - memory/anipsia.md and similar group files
   */
  async migrateAll(memoryDir: string): Promise<MigrationResult> {
    const start = Date.now();
    const combined: MigrationResult = {
      chunksCreated: 0,
      chunksSkipped: 0,
      errors: [],
      duration: 0,
    };

    function merge(r: MigrationResult) {
      combined.chunksCreated += r.chunksCreated;
      combined.chunksSkipped += r.chunksSkipped;
      combined.errors.push(...r.errors);
    }

    // 1. MEMORY.md (in parent directory)
    const workspaceRoot = path.dirname(memoryDir);
    const memoryMdPath = path.join(workspaceRoot, "MEMORY.md");
    if (fs.existsSync(memoryMdPath)) {
      this.log(`Migrating MEMORY.md...`);
      merge(await this.migrateMemoryMd(memoryMdPath));
    }

    // 2. Daily logs
    const dailyLogPattern = /^\d{4}-\d{2}-\d{2}\.md$/;
    const files = fs.readdirSync(memoryDir);
    const dailyLogs = files.filter((f) => dailyLogPattern.test(f)).toSorted();

    for (const logFile of dailyLogs) {
      const date = logFile.replace(".md", "");
      const fullPath = path.join(memoryDir, logFile);
      this.log(`Migrating daily log: ${logFile}...`);
      merge(await this.migrateDailyLog(fullPath, date));
    }

    // 3. Person files
    const peopleDir = path.join(memoryDir, "people");
    if (fs.existsSync(peopleDir)) {
      const personFiles = fs.readdirSync(peopleDir).filter((f) => f.endsWith(".md"));
      for (const pf of personFiles) {
        const personName = this.fileNameToPersonName(pf);
        const fullPath = path.join(peopleDir, pf);
        this.log(`Migrating person file: ${pf} (${personName})...`);
        merge(await this.migratePersonFile(fullPath, personName));
      }
    }

    // 4. Special files (anipsia, etc.)
    const specialFiles = ["anipsia.md"];
    for (const sf of specialFiles) {
      const fullPath = path.join(memoryDir, sf);
      if (fs.existsSync(fullPath)) {
        this.log(`Migrating special file: ${sf}...`);
        merge(
          await this.migrateFile(fullPath, (content, fPath) =>
            parseMemoryMd(content, { filePath: fPath, tier: "long_term" }),
          ),
        );
      }
    }

    combined.duration = Date.now() - start;
    return combined;
  }

  /**
   * Check if a file has already been migrated (by content hash).
   */
  isMigrated(filePath: string): boolean {
    const resolvedPath = path.resolve(filePath);
    const entry = this.manifest.get(resolvedPath);
    if (!entry) {
      return false;
    }

    // Check if file content has changed
    if (!fs.existsSync(filePath)) {
      return true;
    } // File deleted — still "migrated"
    const currentHash = this.hashFile(filePath);
    return entry.hash === currentHash;
  }

  /**
   * Reset migration state for a file (allows re-migration).
   */
  resetFile(filePath: string): void {
    const resolvedPath = path.resolve(filePath);
    this.manifest.delete(resolvedPath);
    this.saveManifest();
  }

  /**
   * Reset all migration state.
   */
  resetAll(): void {
    this.manifest.clear();
    this.saveManifest();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async migrateFile(
    filePath: string,
    parser: (content: string, filePath: string) => ParsedChunk[],
  ): Promise<MigrationResult> {
    const start = Date.now();
    const result: MigrationResult = {
      chunksCreated: 0,
      chunksSkipped: 0,
      errors: [],
      duration: 0,
    };

    const resolvedPath = path.resolve(filePath);

    // Idempotency check
    if (this.isMigrated(filePath)) {
      this.log(`  ⏭ Already migrated: ${path.basename(filePath)}`);
      result.chunksSkipped = 1; // Signal that it was skipped
      result.duration = Date.now() - start;
      return result;
    }

    // Read file
    if (!fs.existsSync(filePath)) {
      result.errors.push(`File not found: ${filePath}`);
      result.duration = Date.now() - start;
      return result;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.trim()) {
      result.duration = Date.now() - start;
      return result;
    }

    // Parse into chunks
    const parsedChunks = parser(content, filePath);

    if (parsedChunks.length === 0) {
      this.log(`  ℹ No chunks extracted from: ${path.basename(filePath)}`);
      result.duration = Date.now() - start;
      return result;
    }

    // Generate embeddings in batches
    let embeddings: number[][] | null = null;
    if (this.embeddings) {
      try {
        const texts = parsedChunks.map((c) => c.plainText);
        embeddings = await this.embeddings.embedBatch(texts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Embedding generation failed: ${msg}`);
        // Continue without embeddings — store the chunks anyway
      }
    }

    // Store chunks
    for (let i = 0; i < parsedChunks.length; i++) {
      const chunk = parsedChunks[i];
      const embedding = embeddings?.[i];

      try {
        this.store.insert(
          {
            tier: chunk.tier,
            content: chunk.content,
            summary: chunk.plainText.length > 200 ? chunk.plainText.slice(0, 200) + "…" : undefined,
            source: chunk.source,
            category: chunk.category,
            person: chunk.person,
            tags: chunk.tags.length > 0 ? chunk.tags : undefined,
            confidence: 1.0,
            createdAt: chunk.createdAt,
            metadata: {
              contextPath: chunk.contextPath,
              migrationSource: "markdown-migration",
            },
          },
          embedding,
        );
        result.chunksCreated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to store chunk: ${msg}`);
      }
    }

    // Record in manifest
    this.manifest.set(resolvedPath, {
      filePath: resolvedPath,
      hash: this.hashFile(filePath),
      chunksCreated: result.chunksCreated,
      migratedAt: Date.now(),
    });
    this.saveManifest();

    this.log(`  ✅ ${path.basename(filePath)}: ${result.chunksCreated} chunks created`);

    result.duration = Date.now() - start;
    return result;
  }

  private hashFile(filePath: string): string {
    const content = fs.readFileSync(filePath, "utf-8");
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  private fileNameToPersonName(fileName: string): string {
    return fileName
      .replace(/\.md$/, "")
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  private loadManifest(): void {
    if (!this.manifestPath || !fs.existsSync(this.manifestPath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.manifestPath, "utf-8");
      const entries: MigrationManifestEntry[] = JSON.parse(raw);
      for (const entry of entries) {
        this.manifest.set(entry.filePath, entry);
      }
    } catch {
      // Corrupt manifest — start fresh
    }
  }

  private saveManifest(): void {
    if (!this.manifestPath) {
      return;
    }

    const dir = path.dirname(this.manifestPath);
    fs.mkdirSync(dir, { recursive: true });

    const entries = [...this.manifest.values()];
    fs.writeFileSync(this.manifestPath, JSON.stringify(entries, null, 2));
  }

  private log(msg: string): void {
    if (!this.quiet) {
      console.log(`[migration] ${msg}`);
    }
  }
}
