/**
 * Hephie Memory Maintenance
 *
 * Background maintenance tasks designed to be called from cron or heartbeat:
 *
 * - `runDecayCycle()` — Move expired Short-Term entries to Episodic
 * - `runPromotionCycle()` — Evaluate Short-Term entries for Long-Term promotion
 *   (simple heuristic: mentioned 3+ times, or confidence > 0.8, or tagged important)
 * - `runVacuum()` — SQLite vacuum + stats logging
 */

import type { MemoryStore } from "./storage/sqlite-store.js";
import type { MemoryChunk } from "./storage/types.js";

// ── Config ────────────────────────────────────────────────────────────────

export interface MaintenanceConfig {
  /** Short-term retention in days (default: 7). */
  shortTermRetentionDays: number;

  /** Confidence threshold for auto-promotion to long-term (default: 0.8). */
  promotionConfidenceThreshold: number;

  /** Minimum access count for promotion consideration (default: 3). */
  promotionMinAccessCount: number;

  /** Tags that indicate importance (chunks with these promote automatically). */
  importantTags: string[];

  /** Whether to log stats after vacuum (default: true). */
  logStats: boolean;

  /** Minimum confidence for keeping a chunk in any tier (default: 0.1). */
  minimumConfidence: number;

  /** Decay rate per day for short-term chunks (multiplied by days since update). */
  shortTermDecayRate: number;
}

const DEFAULT_CONFIG: MaintenanceConfig = {
  shortTermRetentionDays: 7,
  promotionConfidenceThreshold: 0.8,
  promotionMinAccessCount: 3,
  importantTags: ["important", "remember", "critical", "standing-directive"],
  logStats: true,
  minimumConfidence: 0.1,
  shortTermDecayRate: 0.1,
};

// ── MaintenanceResult ─────────────────────────────────────────────────────

export interface MaintenanceResult {
  /** How many chunks were affected. */
  affected: number;
  /** What happened. */
  details: string;
  /** Errors (non-fatal). */
  errors: string[];
  /** Duration in ms. */
  durationMs: number;
}

// ── MemoryMaintenance ─────────────────────────────────────────────────────

export class MemoryMaintenance {
  private readonly store: MemoryStore;
  private readonly config: MaintenanceConfig;

  constructor(store: MemoryStore, configOverride?: Partial<MaintenanceConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...configOverride };
  }

  /**
   * Run a decay cycle:
   * 1. Delete truly expired chunks (expiresAt < now).
   * 2. Move short-term chunks older than retention period to episodic.
   *
   * Returns count of chunks affected.
   */
  runDecayCycle(): number {
    const start = Date.now();
    let affected = 0;

    // Step 1: Delete explicitly expired chunks
    const expired = this.store.deleteExpired();
    affected += expired;

    // Step 2: Decay old short-term to episodic
    const retentionMs = this.config.shortTermRetentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - retentionMs);
    const decayed = this.store.decay(cutoff, "short_term", "episodic");
    affected += decayed;

    if (affected > 0) {
      console.log(
        `[hephie:maintenance] Decay cycle: ${expired} expired deleted, ${decayed} short→episodic (${Date.now() - start}ms)`,
      );
    }

    return affected;
  }

  /**
   * Run a promotion cycle:
   * Evaluate short-term entries for promotion to long-term.
   *
   * Promotion criteria (any one is sufficient):
   * 1. Confidence > threshold (default 0.8)
   * 2. Has an "important" tag
   * 3. Metadata indicates high access count (≥ 3)
   *
   * Returns count of chunks promoted.
   */
  runPromotionCycle(): number {
    const start = Date.now();
    const shortTermChunks = this.store.getByTier("short_term", { limit: 500 });
    let promoted = 0;
    const errors: string[] = [];

    for (const chunk of shortTermChunks) {
      try {
        if (this.shouldPromote(chunk)) {
          this.store.promote(chunk.id, "long_term");
          promoted++;
        }
      } catch (err) {
        errors.push(
          `Failed to promote ${chunk.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (promoted > 0 || errors.length > 0) {
      console.log(
        `[hephie:maintenance] Promotion cycle: ${promoted}/${shortTermChunks.length} promoted, ${errors.length} errors (${Date.now() - start}ms)`,
      );
    }

    return promoted;
  }

  /**
   * Run vacuum: clean up storage and log stats.
   * Returns a maintenance result with stats.
   */
  runVacuum(): MaintenanceResult {
    const start = Date.now();
    const errors: string[] = [];

    // Step 1: Delete expired chunks
    let affected = 0;
    try {
      affected = this.store.deleteExpired();
    } catch (err) {
      errors.push(`deleteExpired failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 2: Run SQLite VACUUM
    try {
      this.store.vacuum();
    } catch (err) {
      errors.push(`vacuum failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 3: Log stats
    let details = `Vacuumed: ${affected} expired chunks removed.`;
    if (this.config.logStats) {
      try {
        const stats = this.store.stats();
        details += ` Total: ${stats.totalChunks} chunks.`;
        details += ` By tier: W=${stats.byTier.working} ST=${stats.byTier.short_term} LT=${stats.byTier.long_term} EP=${stats.byTier.episodic}.`;
        details += ` DB size: ${(stats.dbSizeBytes / 1024).toFixed(1)}KB.`;
        console.log(`[hephie:maintenance] ${details}`);
      } catch (err) {
        errors.push(`stats failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      affected,
      details,
      errors,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Run all maintenance tasks in sequence.
   */
  runAll(): { decay: number; promotion: number; vacuum: MaintenanceResult } {
    const decay = this.runDecayCycle();
    const promotion = this.runPromotionCycle();
    const vacuum = this.runVacuum();
    return { decay, promotion, vacuum };
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Determine if a short-term chunk should be promoted to long-term.
   */
  private shouldPromote(chunk: MemoryChunk): boolean {
    // Criterion 1: High confidence
    if (chunk.confidence >= this.config.promotionConfidenceThreshold) {
      return true;
    }

    // Criterion 2: Has an important tag
    if (chunk.tags && chunk.tags.length > 0) {
      const hasImportantTag = chunk.tags.some((t) =>
        this.config.importantTags.includes(t.toLowerCase()),
      );
      if (hasImportantTag) {
        return true;
      }
    }

    // Criterion 3: High access count (stored in metadata)
    const accessCount = (chunk.metadata?.accessCount as number | undefined) ?? 0;
    if (accessCount >= this.config.promotionMinAccessCount) {
      return true;
    }

    // Criterion 4: Explicitly marked important in metadata
    if (chunk.metadata?.important === true) {
      return true;
    }

    return false;
  }
}
