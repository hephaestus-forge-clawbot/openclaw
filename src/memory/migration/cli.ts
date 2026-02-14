#!/usr/bin/env node
/**
 * Hephie memory migration CLI.
 *
 * Usage:
 *   hephie memory migrate              # Migrate all memory files
 *   hephie memory migrate --file X     # Migrate a specific file
 *   hephie memory migrate --reset      # Reset manifest and re-migrate all
 *   hephie memory stats                # Show memory store statistics
 *   hephie memory search "query"       # Search memory from CLI
 *
 * Standalone — does not require the full gateway.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { MemoryMigrator } from "./migrator.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(
    `
Hephie Memory CLI

Usage:
  hephie-memory migrate [options]     Migrate markdown memory files
  hephie-memory stats                 Show memory store statistics
  hephie-memory search <query>        Search stored memories

Options for 'migrate':
  --file <path>      Migrate a specific file
  --memory-dir <dir> Path to memory/ directory (default: ~/.openclaw/workspace/memory)
  --db <path>        Path to SQLite database (default: ~/.openclaw/workspace/memory.db)
  --reset            Reset migration state and re-migrate
  --no-embeddings    Skip embedding generation
  --help             Show this help

Options for 'search':
  --limit <n>        Max results (default: 10)
  --tier <tier>      Filter by tier
  --person <name>    Filter by person
  --category <cat>   Filter by category
`.trim(),
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandMigrate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: "string" },
      "memory-dir": { type: "string" },
      db: { type: "string" },
      reset: { type: "boolean", default: false },
      "no-embeddings": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const workspaceDir = path.join(home, ".openclaw", "workspace");
  const memoryDir = values["memory-dir"] ?? path.join(workspaceDir, "memory");
  const dbPath = values.db ?? path.join(workspaceDir, "memory.db");
  const manifestPath = path.join(path.dirname(dbPath), ".migration-manifest.json");

  // Lazy-import to avoid pulling in sqlite at parse time
  const { MemoryStore } = await import("../storage/sqlite-store.js");

  // Open store (vector search disabled for migration — we just store embeddings)
  const store = await MemoryStore.open({
    dbPath,
    enableFts: true,
    enableVector: true,
  });

  let embeddings = null;
  if (!values["no-embeddings"]) {
    try {
      const { createEmbeddingProvider } = await import("../embeddings/index.js");
      embeddings = await createEmbeddingProvider();
      console.log(`[cli] Embedding provider ready: ${embeddings.modelId}`);
    } catch (err) {
      console.warn(`[cli] Could not load embedding provider — proceeding without embeddings`);
      console.warn(`[cli]   ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const migrator = new MemoryMigrator(store, embeddings, { manifestPath });

  if (values.reset) {
    console.log("[cli] Resetting migration manifest...");
    migrator.resetAll();
  }

  let result;
  if (values.file) {
    const filePath = path.resolve(values.file);
    console.log(`[cli] Migrating file: ${filePath}`);

    if (filePath.includes("MEMORY.md")) {
      result = await migrator.migrateMemoryMd(filePath);
    } else if (/\d{4}-\d{2}-\d{2}\.md$/.test(filePath)) {
      const date = path.basename(filePath).replace(".md", "");
      result = await migrator.migrateDailyLog(filePath, date);
    } else if (filePath.includes("/people/")) {
      const personName = path
        .basename(filePath, ".md")
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      result = await migrator.migratePersonFile(filePath, personName);
    } else {
      result = await migrator.migrateMemoryMd(filePath);
    }
  } else {
    console.log(`[cli] Migrating all files from: ${memoryDir}`);
    result = await migrator.migrateAll(memoryDir);
  }

  console.log("\n─── Migration Complete ───");
  console.log(`  Chunks created:  ${result.chunksCreated}`);
  console.log(`  Chunks skipped:  ${result.chunksSkipped}`);
  console.log(`  Errors:          ${result.errors.length}`);
  console.log(`  Duration:        ${(result.duration / 1000).toFixed(1)}s`);

  if (result.errors.length > 0) {
    console.log("\n  Errors:");
    for (const err of result.errors) {
      console.log(`    ⚠ ${err}`);
    }
  }

  // Show stats after migration
  const stats = store.stats();
  console.log("\n─── Store Stats ───");
  console.log(`  Total chunks:    ${stats.totalChunks}`);
  console.log(`  By tier:`);
  for (const [tier, count] of Object.entries(stats.byTier)) {
    if (count > 0) {
      console.log(`    ${tier}: ${count}`);
    }
  }
  console.log(`  By category:`);
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    if (count > 0) {
      console.log(`    ${cat}: ${count}`);
    }
  }
  if (Object.keys(stats.byPerson).length > 0) {
    console.log(`  By person:`);
    for (const [person, count] of Object.entries(stats.byPerson)) {
      console.log(`    ${person}: ${count}`);
    }
  }
  console.log(`  DB size:         ${(stats.dbSizeBytes / 1024).toFixed(0)} KB`);

  store.close();
}

async function commandStats(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
    },
    strict: false,
  });

  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const dbPath = values.db ?? path.join(home, ".openclaw", "workspace", "memory.db");

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error(`Run 'hephie-memory migrate' first.`);
    process.exit(1);
  }

  const { MemoryStore } = await import("../storage/sqlite-store.js");
  const store = await MemoryStore.open({
    dbPath,
    enableFts: true,
    enableVector: false, // Don't need vec for stats
  });

  const stats = store.stats();

  console.log("─── Memory Store Statistics ───");
  console.log(`  Total chunks:    ${stats.totalChunks}`);
  console.log(
    `  Oldest:          ${stats.oldestChunk ? new Date(stats.oldestChunk).toISOString() : "none"}`,
  );
  console.log(
    `  Newest:          ${stats.newestChunk ? new Date(stats.newestChunk).toISOString() : "none"}`,
  );
  console.log(`  DB size:         ${(stats.dbSizeBytes / 1024).toFixed(0)} KB`);

  console.log("\n  By tier:");
  for (const [tier, count] of Object.entries(stats.byTier)) {
    if (count > 0) {
      console.log(`    ${tier}: ${count}`);
    }
  }

  console.log("\n  By category:");
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    if (count > 0) {
      console.log(`    ${cat}: ${count}`);
    }
  }

  if (Object.keys(stats.byPerson).length > 0) {
    console.log("\n  By person:");
    for (const [person, count] of Object.entries(stats.byPerson)) {
      console.log(`    ${person}: ${count}`);
    }
  }

  store.close();
}

async function commandSearch(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      limit: { type: "string" },
      tier: { type: "string" },
      person: { type: "string" },
      category: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const query = positionals.join(" ");
  if (!query) {
    console.error("Usage: hephie-memory search <query>");
    process.exit(1);
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const dbPath = values.db ?? path.join(home, ".openclaw", "workspace", "memory.db");

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const { MemoryStore } = await import("../storage/sqlite-store.js");
  const store = await MemoryStore.open({
    dbPath,
    enableFts: true,
    enableVector: true,
  });

  const limit = values.limit ? parseInt(values.limit, 10) : 10;

  // Try FTS search
  const results = store.fullTextSearch(query, {
    limit,
    tier: values.tier as "working" | "short_term" | "long_term" | "episodic" | undefined,
    person: values.person,
    category: values.category,
  });

  if (results.length === 0) {
    console.log(`No results for: "${query}"`);
  } else {
    console.log(`─── ${results.length} results for "${query}" ───\n`);
    for (const { chunk, score } of results) {
      const date = new Date(chunk.createdAt).toISOString().split("T")[0];
      const tierTag = `[${chunk.tier}]`;
      const catTag = chunk.category ? `[${chunk.category}]` : "";
      const personTag = chunk.person ? `(${chunk.person})` : "";

      console.log(`${tierTag} ${catTag} ${personTag} ${date}  score=${score.toFixed(3)}`);
      console.log(`  ${chunk.content.slice(0, 200).replace(/\n/g, "\n  ")}`);
      if (chunk.tags?.length) {
        console.log(`  tags: ${chunk.tags.join(", ")}`);
      }
      console.log();
    }
  }

  store.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case "migrate":
      await commandMigrate(commandArgs);
      break;
    case "stats":
      await commandStats(commandArgs);
      break;
    case "search":
      await commandSearch(commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
