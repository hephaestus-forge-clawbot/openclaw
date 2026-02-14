/**
 * Thread Lifecycle Manager (Hephie Phase 3.3)
 *
 * Manages thread lifecycle transitions:
 *   open → active → stale → closed → archived
 *
 * Handles:
 * - Auto-transition based on inactivity
 * - Summary generation on close
 * - Thread cleanup and archival
 */

import type { ThreadStore } from "./thread-store.js";
import type { UnifiedThread, ThreadStatus, ThreadConfig } from "./thread-types.js";
import { DEFAULT_THREAD_CONFIG } from "./thread-types.js";

/**
 * Result of a lifecycle maintenance run.
 */
export interface MaintenanceResult {
  /** Threads transitioned to stale. */
  staled: number;

  /** Threads transitioned to closed. */
  closed: number;

  /** Threads transitioned to archived. */
  archived: number;

  /** Threads that had summaries generated. */
  summarized: number;

  /** Total threads processed. */
  total: number;
}

/**
 * Summary generator function type.
 * Takes thread messages and returns a summary with decisions/action items.
 */
export type SummaryGenerator = (params: {
  topic?: string;
  messages: Array<{ sender: string; content: string; channelType: string }>;
}) => Promise<{
  summary: string;
  decisions?: string[];
  actionItems?: string[];
}>;

/**
 * Thread Lifecycle Manager.
 */
export class ThreadManager {
  private readonly store: ThreadStore;
  private readonly config: ThreadConfig;
  private summaryGenerator?: SummaryGenerator;

  constructor(
    store: ThreadStore,
    config?: Partial<ThreadConfig>,
    summaryGenerator?: SummaryGenerator,
  ) {
    this.store = store;
    this.config = { ...DEFAULT_THREAD_CONFIG, ...config };
    this.summaryGenerator = summaryGenerator;
  }

  /**
   * Set the summary generator function.
   */
  setSummaryGenerator(generator: SummaryGenerator): void {
    this.summaryGenerator = generator;
  }

  /**
   * Run lifecycle maintenance — transition threads based on inactivity.
   */
  async runMaintenance(now?: number): Promise<MaintenanceResult> {
    const currentTime = now ?? Date.now();
    const result: MaintenanceResult = {
      staled: 0,
      closed: 0,
      archived: 0,
      summarized: 0,
      total: 0,
    };

    // 1. Active/Open → Stale (after staleAfterMs of inactivity)
    const staleCutoff = currentTime - this.config.staleAfterMs;
    const toStale = [
      ...this.store.getThreadsByStatusOlderThan("open", staleCutoff),
      ...this.store.getThreadsByStatusOlderThan("active", staleCutoff),
    ];

    for (const thread of toStale) {
      this.store.updateThread(thread.threadId, { status: "stale" }, currentTime);
      result.staled++;
      result.total++;
    }

    // 2. Stale → Closed (after closeAfterMs of inactivity)
    const closeCutoff = currentTime - this.config.closeAfterMs;
    const toClose = this.store.getThreadsByStatusOlderThan("stale", closeCutoff);

    for (const thread of toClose) {
      await this.closeThread(thread, currentTime);
      result.closed++;
      result.total++;
      if (this.config.autoSummarize && this.summaryGenerator) {
        result.summarized++;
      }
    }

    // 3. Closed → Archived (after archiveAfterMs since closing)
    const archiveCutoff = currentTime - this.config.archiveAfterMs;
    const toArchive = this.store.getThreadsByStatusOlderThan("closed", archiveCutoff);

    for (const thread of toArchive) {
      this.store.updateThread(thread.threadId, { status: "archived" }, currentTime);
      result.archived++;
      result.total++;
    }

    return result;
  }

  /**
   * Close a thread — generate summary and transition to closed.
   */
  async closeThread(thread: UnifiedThread, now?: number): Promise<UnifiedThread> {
    const currentTime = now ?? Date.now();

    const updates: Partial<UnifiedThread> = {
      status: "closed" as ThreadStatus,
      closedAt: currentTime,
    };

    // Generate summary if auto-summarize is enabled
    if (this.config.autoSummarize && this.summaryGenerator) {
      const messages = this.store.getMessages(thread.threadId);
      if (messages.length > 0) {
        try {
          const summaryResult = await this.summaryGenerator({
            topic: thread.topic,
            messages: messages.map((m) => ({
              sender: m.sender,
              content: m.content,
              channelType: m.channelType,
            })),
          });

          updates.summary = summaryResult.summary;
          updates.decisions = summaryResult.decisions;
          updates.actionItems = summaryResult.actionItems;
        } catch {
          // Summary generation failed — close without summary
          updates.summary = `Thread with ${thread.participants.length} participants across ${thread.channels.length} channels. ${this.store.getMessageCount(thread.threadId)} messages exchanged.`;
        }
      }
    } else {
      // Simple summary without LLM
      const messageCount = this.store.getMessageCount(thread.threadId);
      updates.summary = `Thread with ${thread.participants.length} participant${thread.participants.length === 1 ? "" : "s"} across ${thread.channels.length} channel${thread.channels.length === 1 ? "" : "s"}. ${messageCount} message${messageCount === 1 ? "" : "s"} exchanged.`;
    }

    this.store.updateThread(thread.threadId, updates, currentTime);
    return this.store.getThread(thread.threadId)!;
  }

  /**
   * Manually transition a thread to a specific status.
   */
  transitionThread(threadId: string, newStatus: ThreadStatus, now?: number): boolean {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      return false;
    }

    // Validate transition
    if (!isValidTransition(thread.status, newStatus)) {
      return false;
    }

    const updates: Partial<UnifiedThread> = { status: newStatus };
    if (newStatus === "closed") {
      updates.closedAt = now ?? Date.now();
    }

    return this.store.updateThread(threadId, updates, now);
  }

  /**
   * Reopen a closed or stale thread.
   */
  reopenThread(threadId: string, now?: number): boolean {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      return false;
    }

    if (thread.status !== "closed" && thread.status !== "stale") {
      return false;
    }

    return this.store.updateThread(threadId, { status: "active", closedAt: undefined }, now);
  }

  /**
   * Get the current threading configuration.
   */
  getConfig(): ThreadConfig {
    return { ...this.config };
  }

  /**
   * Get thread statistics from the store.
   */
  getStats(): ReturnType<ThreadStore["getStats"]> {
    return this.store.getStats();
  }
}

/**
 * Validate a thread status transition.
 */
function isValidTransition(from: ThreadStatus, to: ThreadStatus): boolean {
  const validTransitions: Record<ThreadStatus, ThreadStatus[]> = {
    open: ["active", "stale", "closed"],
    active: ["stale", "closed"],
    stale: ["active", "closed"],
    closed: ["active", "archived"], // Can reopen
    archived: [], // Terminal state
  };

  return validTransitions[from]?.includes(to) ?? false;
}
