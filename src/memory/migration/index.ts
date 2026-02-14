/**
 * Hephie Memory Migration — Public API
 *
 * Tools for migrating markdown memory files into the Hephie 4-tier
 * memory storage system.
 *
 * Usage:
 *   import { MemoryMigrator, parseMemoryMd, parseDailyLog } from "./memory/migration/index.js";
 */

export { MemoryMigrator } from "./migrator.js";
export type { MigrationResult } from "./migrator.js";

export {
  parseMemoryMd,
  parseDailyLog,
  parsePersonFile,
  parseSections,
  splitIntoAtomicChunks,
  inferCategory,
  extractPerson,
  extractTags,
  stripMarkdown,
  parseDateFromPath,
  parseTimeFromHeader,
} from "./markdown-parser.js";
export type { ParsedChunk, ParseOptions } from "./markdown-parser.js";
