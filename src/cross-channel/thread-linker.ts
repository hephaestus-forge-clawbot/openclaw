/**
 * Thread Linker (Hephie Phase 3.3)
 *
 * Handles linking messages to unified threads — both explicit and implicit.
 * The core intelligence of the threading system.
 *
 * Explicit linking: agent/system directly assigns a message to a thread.
 * Implicit linking: auto-detection of related messages across channels
 *   using topic similarity + time windows + participant matching.
 * Platform linking: maps native thread IDs to unified threads.
 */

import type { ThreadStore } from "./thread-store.js";
import type {
  UnifiedThread,
  ThreadMessage,
  ThreadConfig,
  PlatformThreadMapping,
} from "./thread-types.js";
import type { ChannelType } from "./types.js";
import { DEFAULT_THREAD_CONFIG } from "./thread-types.js";
import { computeThreadSimilarity, computeTopicSimilarity } from "./topic-similarity.js";

/**
 * Result of attempting to link a message to a thread.
 */
export interface LinkResult {
  /** Whether the message was linked to a thread. */
  linked: boolean;

  /** The thread the message was linked to (or newly created). */
  thread?: UnifiedThread;

  /** The created thread message. */
  message?: ThreadMessage;

  /** How the link was made. */
  linkType?: "explicit" | "implicit" | "platform" | "reply" | "new";

  /** The similarity score (for implicit links). */
  similarity?: number;
}

/**
 * Thread Linker — the brain of the threading system.
 */
export class ThreadLinker {
  private readonly store: ThreadStore;
  private readonly config: ThreadConfig;

  constructor(store: ThreadStore, config?: Partial<ThreadConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_THREAD_CONFIG, ...config };
  }

  /**
   * Explicitly link a message to a specific thread.
   */
  linkToThread(params: {
    threadId: string;
    channelType: ChannelType;
    sender: string;
    content: string;
    platformMessageId?: string;
    channelChatId?: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  }): LinkResult {
    const thread = this.store.getThread(params.threadId);
    if (!thread) {
      return { linked: false };
    }

    const message = this.store.addMessage({
      threadId: params.threadId,
      channelType: params.channelType,
      sender: params.sender,
      content: params.content,
      platformMessageId: params.platformMessageId,
      channelChatId: params.channelChatId,
      linkType: "explicit",
      timestamp: params.timestamp,
      metadata: params.metadata,
    });

    const updatedThread = this.store.getThread(params.threadId)!;

    return {
      linked: true,
      thread: updatedThread,
      message,
      linkType: "explicit",
    };
  }

  /**
   * Try to implicitly link a message to an existing thread.
   * Uses topic similarity + time window + participant matching.
   *
   * If no matching thread is found, optionally creates a new one.
   */
  autoLink(params: {
    channelType: ChannelType;
    sender: string;
    content: string;
    platformMessageId?: string;
    channelChatId?: string;
    timestamp?: number;
    createIfMissing?: boolean;
    topic?: string;
    metadata?: Record<string, unknown>;
  }): LinkResult {
    const now = params.timestamp ?? Date.now();
    const windowStart = now - this.config.implicitLinkWindowMs;

    // Find candidate threads: active/open threads involving this sender
    const candidateThreads = this.store.getActiveThreadsForParticipant(params.sender);

    // Also look for threads on the same channel that are recent
    const channelThreads = this.store.searchThreads({
      channelType: params.channelType,
      status: ["open", "active"],
      updatedAfter: windowStart,
    });

    // Merge and deduplicate candidates
    const candidates = new Map<string, UnifiedThread>();
    for (const t of candidateThreads) {
      candidates.set(t.threadId, t);
    }
    for (const t of channelThreads) {
      candidates.set(t.threadId, t);
    }

    // Score each candidate thread
    let bestThread: UnifiedThread | undefined;
    let bestScore = 0;

    for (const thread of candidates.values()) {
      // Skip threads outside time window
      if (thread.updatedAt < windowStart) {
        continue;
      }

      const score = this.scoreThreadMatch(params.content, params.sender, thread, now);
      if (score > bestScore && score >= this.config.minTopicSimilarity) {
        bestScore = score;
        bestThread = thread;
      }
    }

    if (bestThread) {
      const message = this.store.addMessage({
        threadId: bestThread.threadId,
        channelType: params.channelType,
        sender: params.sender,
        content: params.content,
        platformMessageId: params.platformMessageId,
        channelChatId: params.channelChatId,
        linkType: "implicit",
        timestamp: now,
        metadata: params.metadata,
      });

      const updatedThread = this.store.getThread(bestThread.threadId)!;

      return {
        linked: true,
        thread: updatedThread,
        message,
        linkType: "implicit",
        similarity: bestScore,
      };
    }

    // No match found — create new thread if requested
    if (params.createIfMissing) {
      const thread = this.store.createThread({
        topic: params.topic,
        participants: [params.sender],
        channels: [params.channelType],
        now,
      });

      const message = this.store.addMessage({
        threadId: thread.threadId,
        channelType: params.channelType,
        sender: params.sender,
        content: params.content,
        platformMessageId: params.platformMessageId,
        channelChatId: params.channelChatId,
        linkType: "explicit",
        timestamp: now,
        metadata: params.metadata,
      });

      return {
        linked: true,
        thread,
        message,
        linkType: "new",
      };
    }

    return { linked: false };
  }

  /**
   * Link a message via platform thread mapping.
   * Checks if the platform thread ID maps to a unified thread.
   */
  linkViaPlatform(params: {
    channelType: ChannelType;
    platformThreadId: string;
    platformChatId: string;
    sender: string;
    content: string;
    platformMessageId?: string;
    timestamp?: number;
    createIfMissing?: boolean;
    topic?: string;
    metadata?: Record<string, unknown>;
  }): LinkResult {
    const now = params.timestamp ?? Date.now();

    // Check for existing mapping
    const existingThread = this.store.getThreadByPlatformId(
      params.channelType,
      params.platformThreadId,
      params.platformChatId,
    );

    if (existingThread) {
      const message = this.store.addMessage({
        threadId: existingThread.threadId,
        channelType: params.channelType,
        sender: params.sender,
        content: params.content,
        platformMessageId: params.platformMessageId,
        channelChatId: params.platformChatId,
        linkType: "platform",
        timestamp: now,
        metadata: params.metadata,
      });

      const updatedThread = this.store.getThread(existingThread.threadId)!;

      return {
        linked: true,
        thread: updatedThread,
        message,
        linkType: "platform",
      };
    }

    // No mapping — create thread and mapping if requested
    if (params.createIfMissing) {
      const thread = this.store.createThread({
        topic: params.topic,
        participants: [params.sender],
        channels: [params.channelType],
        now,
      });

      this.store.addPlatformMapping({
        threadId: thread.threadId,
        channelType: params.channelType,
        platformThreadId: params.platformThreadId,
        platformChatId: params.platformChatId,
        now,
      });

      const message = this.store.addMessage({
        threadId: thread.threadId,
        channelType: params.channelType,
        sender: params.sender,
        content: params.content,
        platformMessageId: params.platformMessageId,
        channelChatId: params.platformChatId,
        linkType: "platform",
        timestamp: now,
        metadata: params.metadata,
      });

      return {
        linked: true,
        thread,
        message,
        linkType: "platform",
      };
    }

    return { linked: false };
  }

  /**
   * Link a reply message to the same thread as the original message.
   */
  linkReply(params: {
    replyToMessageId: string;
    channelType: ChannelType;
    sender: string;
    content: string;
    platformMessageId?: string;
    channelChatId?: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  }): LinkResult {
    // Find the original message's thread by scanning — in production,
    // you'd want a direct message_id → thread_id index
    const now = params.timestamp ?? Date.now();

    // Search recent messages to find the one we're replying to
    // We look in thread_messages for the platform_message_id
    const threads = this.store.searchThreads({
      status: ["open", "active"],
      limit: 100,
    });

    for (const thread of threads) {
      const messages = this.store.getMessages(thread.threadId);
      const found = messages.find(
        (m) =>
          m.messageId === params.replyToMessageId ||
          m.platformMessageId === params.replyToMessageId,
      );

      if (found) {
        const message = this.store.addMessage({
          threadId: thread.threadId,
          channelType: params.channelType,
          sender: params.sender,
          content: params.content,
          platformMessageId: params.platformMessageId,
          channelChatId: params.channelChatId,
          linkType: "reply",
          timestamp: now,
          metadata: params.metadata,
        });

        const updatedThread = this.store.getThread(thread.threadId)!;

        return {
          linked: true,
          thread: updatedThread,
          message,
          linkType: "reply",
        };
      }
    }

    return { linked: false };
  }

  /**
   * Create a platform thread mapping for an existing unified thread.
   */
  mapPlatformThread(params: {
    threadId: string;
    channelType: ChannelType;
    platformThreadId: string;
    platformChatId: string;
  }): PlatformThreadMapping | null {
    const thread = this.store.getThread(params.threadId);
    if (!thread) {
      return null;
    }

    return this.store.addPlatformMapping({
      threadId: params.threadId,
      channelType: params.channelType,
      platformThreadId: params.platformThreadId,
      platformChatId: params.platformChatId,
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Score how well a message matches an existing thread.
   * Combines topic similarity, participant matching, and recency.
   */
  private scoreThreadMatch(
    messageContent: string,
    sender: string,
    thread: UnifiedThread,
    now: number,
  ): number {
    // Get thread messages for topic comparison
    const threadMessages = this.store.getMessages(thread.threadId);
    const threadTexts = threadMessages.map((m) => m.content);

    // Topic similarity (0-1)
    const topicScore = computeThreadSimilarity(messageContent, threadTexts);

    // Participant match bonus (0 or 0.15)
    const participantBonus = thread.participants.includes(sender) ? 0.15 : 0;

    // Recency bonus (0-0.1, newer threads score higher)
    const ageMs = now - thread.updatedAt;
    const maxAge = this.config.implicitLinkWindowMs;
    const recencyBonus = Math.max(0, 0.1 * (1 - ageMs / maxAge));

    // Topic from thread title matching
    let topicBonus = 0;
    if (thread.topic) {
      topicBonus = computeTopicSimilarity(messageContent, thread.topic) * 0.15;
    }

    return topicScore + participantBonus + recencyBonus + topicBonus;
  }
}
