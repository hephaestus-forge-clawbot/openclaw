/**
 * Unified Threading Types (Hephie Phase 3.3)
 *
 * Core types for cross-channel thread linking and thread-aware context.
 * A UnifiedThread connects related messages across channels into a
 * coherent conversation thread.
 */

import type { ChannelType } from "./types.js";

// ── Thread Lifecycle ────────────────────────────────────────────────────

/**
 * Thread lifecycle states:
 * - open: just created, initial message(s) linked
 * - active: ongoing conversation with recent messages
 * - stale: no activity for a while but not yet closed
 * - closed: auto-closed after inactivity, summary generated
 * - archived: long-term storage, no longer surfaced in context
 */
export type ThreadStatus = "open" | "active" | "stale" | "closed" | "archived";

// ── Core Types ──────────────────────────────────────────────────────────

/**
 * A message linked to a unified thread. Can come from any channel.
 */
export interface ThreadMessage {
  /** Unique message ID (generated). */
  messageId: string;

  /** The unified thread this message belongs to. */
  threadId: string;

  /** Channel this message came from. */
  channelType: ChannelType;

  /** Channel-specific message ID (e.g., Telegram message_id). */
  platformMessageId?: string;

  /** Channel-specific chat/conversation ID. */
  channelChatId?: string;

  /** Who sent this message (canonical name). */
  sender: string;

  /** Message content (text). */
  content: string;

  /** When this message was sent (ms epoch). */
  timestamp: number;

  /** How this message was linked to the thread. */
  linkType: "explicit" | "implicit" | "platform" | "reply";

  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * A platform-native thread mapping.
 * Maps a platform's thread ID to a unified thread.
 */
export interface PlatformThreadMapping {
  /** The unified thread ID. */
  threadId: string;

  /** The channel type (slack, telegram, discord). */
  channelType: ChannelType;

  /** The platform-specific thread identifier. */
  platformThreadId: string;

  /** The platform-specific chat/channel ID. */
  platformChatId: string;

  /** When this mapping was created. */
  createdAt: number;
}

/**
 * A unified thread linking messages across channels.
 */
export interface UnifiedThread {
  /** Unique thread ID. */
  threadId: string;

  /** Current lifecycle status. */
  status: ThreadStatus;

  /** Topic or subject of this thread. */
  topic?: string;

  /** Summary generated when the thread is closed. */
  summary?: string;

  /** Key decisions extracted on close. */
  decisions?: string[];

  /** Action items extracted on close. */
  actionItems?: string[];

  /** Participants (canonical names). */
  participants: string[];

  /** Channels this thread spans. */
  channels: ChannelType[];

  /** When the thread was created. */
  createdAt: number;

  /** When the thread was last updated (last message). */
  updatedAt: number;

  /** When the thread was closed (if closed). */
  closedAt?: number;

  /** Messages in this thread (loaded on demand). */
  messages?: ThreadMessage[];

  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

// ── Search & Query ──────────────────────────────────────────────────────

/**
 * Search criteria for finding threads.
 */
export interface ThreadSearchCriteria {
  /** Filter by participant (canonical name). */
  participant?: string;

  /** Filter by topic (substring match). */
  topic?: string;

  /** Filter by channel type. */
  channelType?: ChannelType;

  /** Filter by status. */
  status?: ThreadStatus | ThreadStatus[];

  /** Filter by date range — threads updated after this time. */
  updatedAfter?: number;

  /** Filter by date range — threads updated before this time. */
  updatedBefore?: number;

  /** Filter by date range — threads created after this time. */
  createdAfter?: number;

  /** Filter by date range — threads created before this time. */
  createdBefore?: number;

  /** Maximum results to return. */
  limit?: number;

  /** Offset for pagination. */
  offset?: number;

  /** Sort order. */
  orderBy?: "createdAt" | "updatedAt";

  /** Sort direction. */
  order?: "asc" | "desc";
}

// ── Configuration ───────────────────────────────────────────────────────

/**
 * Configuration for the unified threading system.
 */
export interface ThreadConfig {
  /** Enable/disable unified threading (default: true). */
  enabled: boolean;

  /** Time window (ms) for implicit linking — messages within this window
   *  from the same person are candidates for auto-linking (default: 30 min). */
  implicitLinkWindowMs: number;

  /** Minimum topic similarity score (0-1) for auto-linking (default: 0.3). */
  minTopicSimilarity: number;

  /** Inactivity period (ms) before a thread becomes stale (default: 2 hours). */
  staleAfterMs: number;

  /** Inactivity period (ms) before a stale thread is closed (default: 24 hours). */
  closeAfterMs: number;

  /** Inactivity period (ms) before a closed thread is archived (default: 7 days). */
  archiveAfterMs: number;

  /** Token budget fraction for thread context injection (default: 0.1 = 10%). */
  contextBudgetFraction: number;

  /** Maximum number of thread messages to inject (default: 20). */
  maxContextMessages: number;

  /** Whether to respect per-person privacy compartments (default: true). */
  respectPrivacy: boolean;

  /** Whether to auto-generate summaries on close (default: true). */
  autoSummarize: boolean;

  /** Maximum number of messages to keep per thread (0 = unlimited). */
  maxMessagesPerThread: number;
}

/**
 * Default threading configuration.
 */
export const DEFAULT_THREAD_CONFIG: ThreadConfig = {
  enabled: true,
  implicitLinkWindowMs: 30 * 60 * 1000, // 30 minutes
  minTopicSimilarity: 0.3,
  staleAfterMs: 2 * 60 * 60 * 1000, // 2 hours
  closeAfterMs: 24 * 60 * 60 * 1000, // 24 hours
  archiveAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  contextBudgetFraction: 0.1,
  maxContextMessages: 20,
  respectPrivacy: true,
  autoSummarize: true,
  maxMessagesPerThread: 0,
};

// ── Context Injection ───────────────────────────────────────────────────

/**
 * Thread context prepared for injection into LLM prompt.
 */
export interface ThreadContextInjection {
  /** The unified thread providing context. */
  threadId: string;

  /** The thread topic. */
  topic?: string;

  /** Messages selected for injection (within budget). */
  messages: ThreadMessage[];

  /** Channels represented in the injected context. */
  channels: ChannelType[];

  /** Estimated token count of the injected context. */
  estimatedTokens: number;

  /** The formatted context string for injection. */
  formattedContext: string;
}
