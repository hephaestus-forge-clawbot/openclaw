/**
 * Cross-Channel Message Queue (Hephie Phase 3.2)
 *
 * Persistent message queue with retry logic for cross-channel messaging.
 * Survives restarts by persisting to disk.
 *
 * Features:
 * - Configurable retry policy (exponential backoff)
 * - Dead letter queue for permanently failed messages
 * - Disk persistence (JSON file)
 * - Queue status introspection
 */

import fs from "node:fs";
import path from "node:path";
import type { ChannelType } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface QueuedMessage {
  /** Unique message ID. */
  id: string;

  /** Target channel. */
  channel: ChannelType;

  /** Destination (chat ID, user ID, etc.). */
  to: string;

  /** Message text content. */
  message: string;

  /** Optional account ID for multi-account channels. */
  accountId?: string;

  /** Optional thread ID. */
  threadId?: string | number;

  /** When the message was first queued. */
  createdAt: number;

  /** Number of delivery attempts so far. */
  attempts: number;

  /** Timestamp of the last delivery attempt. */
  lastAttemptAt?: number;

  /** Timestamp of when the next retry is scheduled. */
  nextRetryAt?: number;

  /** Error from the last failed attempt. */
  lastError?: string;

  /** Whether this message is in the dead letter queue. */
  dead: boolean;

  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

export interface RetryPolicy {
  /** Maximum number of delivery attempts (default: 3). */
  maxAttempts: number;

  /** Base delay in ms for exponential backoff (default: 1000). */
  baseDelayMs: number;

  /** Maximum delay in ms (default: 30000). */
  maxDelayMs: number;

  /** Multiplier for exponential backoff (default: 2). */
  backoffMultiplier: number;
}

export interface MessageQueueConfig {
  /** Path to the queue persistence file. */
  persistPath: string;

  /** Retry policy. */
  retryPolicy?: Partial<RetryPolicy>;

  /** Auto-save after each mutation (default: true). */
  autoSave?: boolean;
}

export interface QueueStats {
  /** Number of messages waiting for delivery. */
  pending: number;

  /** Number of messages in the dead letter queue. */
  dead: number;

  /** Total messages (pending + dead). */
  total: number;

  /** Oldest message timestamp. */
  oldestMessageAt?: number;
}

// ── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
};

// ── Queue Implementation ──────────────────────────────────────────────────

let messageIdCounter = 0;

function generateMessageId(): string {
  const now = Date.now();
  messageIdCounter += 1;
  return `msg_${now}_${messageIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Calculate the next retry delay using exponential backoff.
 */
export function calculateRetryDelay(attempt: number, policy: RetryPolicy): number {
  const delay = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  return Math.min(delay, policy.maxDelayMs);
}

export class MessageQueue {
  private messages: Map<string, QueuedMessage> = new Map();
  private readonly config: MessageQueueConfig;
  private readonly retryPolicy: RetryPolicy;
  private readonly autoSave: boolean;

  constructor(config: MessageQueueConfig) {
    this.config = config;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retryPolicy };
    this.autoSave = config.autoSave ?? true;
  }

  /**
   * Create a MessageQueue and load any persisted messages from disk.
   */
  static async create(config: MessageQueueConfig): Promise<MessageQueue> {
    const queue = new MessageQueue(config);
    await queue.load();
    return queue;
  }

  /**
   * Enqueue a new message for delivery.
   */
  async enqueue(params: {
    channel: ChannelType;
    to: string;
    message: string;
    accountId?: string;
    threadId?: string | number;
    metadata?: Record<string, unknown>;
  }): Promise<QueuedMessage> {
    const now = Date.now();
    const msg: QueuedMessage = {
      id: generateMessageId(),
      channel: params.channel,
      to: params.to,
      message: params.message,
      accountId: params.accountId,
      threadId: params.threadId,
      createdAt: now,
      attempts: 0,
      dead: false,
      metadata: params.metadata,
    };

    this.messages.set(msg.id, msg);
    if (this.autoSave) {
      await this.save();
    }
    return { ...msg };
  }

  /**
   * Get the next message ready for delivery (oldest pending, past retry time).
   */
  getNextPending(now?: number): QueuedMessage | undefined {
    const currentTime = now ?? Date.now();
    let oldest: QueuedMessage | undefined;

    for (const msg of this.messages.values()) {
      if (msg.dead) {
        continue;
      }
      if (msg.nextRetryAt && msg.nextRetryAt > currentTime) {
        continue;
      }

      if (!oldest || msg.createdAt < oldest.createdAt) {
        oldest = msg;
      }
    }

    return oldest ? { ...oldest } : undefined;
  }

  /**
   * Get all pending messages (not dead, ready for retry).
   */
  getPendingMessages(now?: number): QueuedMessage[] {
    const currentTime = now ?? Date.now();
    return Array.from(this.messages.values())
      .filter((msg) => !msg.dead && (!msg.nextRetryAt || msg.nextRetryAt <= currentTime))
      .toSorted((a, b) => a.createdAt - b.createdAt)
      .map((msg) => ({ ...msg }));
  }

  /**
   * Mark a message as successfully delivered (removes it from queue).
   */
  async markDelivered(messageId: string): Promise<boolean> {
    const existed = this.messages.delete(messageId);
    if (existed && this.autoSave) {
      await this.save();
    }
    return existed;
  }

  /**
   * Record a failed delivery attempt. If max attempts reached, move to DLQ.
   */
  async markFailed(messageId: string, error: string): Promise<QueuedMessage | undefined> {
    const msg = this.messages.get(messageId);
    if (!msg) {
      return undefined;
    }

    msg.attempts += 1;
    msg.lastAttemptAt = Date.now();
    msg.lastError = error;

    if (msg.attempts >= this.retryPolicy.maxAttempts) {
      msg.dead = true;
      msg.nextRetryAt = undefined;
    } else {
      const delay = calculateRetryDelay(msg.attempts, this.retryPolicy);
      msg.nextRetryAt = Date.now() + delay;
    }

    if (this.autoSave) {
      await this.save();
    }
    return { ...msg };
  }

  /**
   * Get all messages in the dead letter queue.
   */
  getDeadLetters(): QueuedMessage[] {
    return Array.from(this.messages.values())
      .filter((msg) => msg.dead)
      .toSorted((a, b) => a.createdAt - b.createdAt)
      .map((msg) => ({ ...msg }));
  }

  /**
   * Retry a dead letter message (move it back to pending).
   */
  async retryDeadLetter(messageId: string): Promise<QueuedMessage | undefined> {
    const msg = this.messages.get(messageId);
    if (!msg || !msg.dead) {
      return undefined;
    }

    msg.dead = false;
    msg.attempts = 0;
    msg.nextRetryAt = undefined;
    msg.lastError = undefined;
    msg.lastAttemptAt = undefined;

    if (this.autoSave) {
      await this.save();
    }
    return { ...msg };
  }

  /**
   * Permanently remove a message from the queue.
   */
  async remove(messageId: string): Promise<boolean> {
    const existed = this.messages.delete(messageId);
    if (existed && this.autoSave) {
      await this.save();
    }
    return existed;
  }

  /**
   * Clear all messages (pending and dead).
   */
  async clear(): Promise<void> {
    this.messages.clear();
    if (this.autoSave) {
      await this.save();
    }
  }

  /**
   * Get queue statistics.
   */
  getStats(): QueueStats {
    let pending = 0;
    let dead = 0;
    let oldestMessageAt: number | undefined;

    for (const msg of this.messages.values()) {
      if (msg.dead) {
        dead++;
      } else {
        pending++;
      }
      if (!oldestMessageAt || msg.createdAt < oldestMessageAt) {
        oldestMessageAt = msg.createdAt;
      }
    }

    return { pending, dead, total: pending + dead, oldestMessageAt };
  }

  /**
   * Get the retry policy.
   */
  getRetryPolicy(): RetryPolicy {
    return { ...this.retryPolicy };
  }

  /**
   * Persist the queue to disk.
   */
  async save(): Promise<void> {
    const data = Array.from(this.messages.values());
    const dir = path.dirname(this.config.persistPath);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.config.persistPath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // Silently fail — queue will be rebuilt from memory
    }
  }

  /**
   * Load the queue from disk.
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.config.persistPath, "utf-8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) {
        return;
      }

      this.messages.clear();
      for (const item of data) {
        if (isQueuedMessage(item)) {
          this.messages.set(item.id, item);
        }
      }
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }
  }

  /**
   * Total number of messages in queue (pending + dead).
   */
  get size(): number {
    return this.messages.size;
  }
}

// ── Type Guard ────────────────────────────────────────────────────────────

function isQueuedMessage(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.channel === "string" &&
    typeof obj.to === "string" &&
    typeof obj.message === "string" &&
    typeof obj.createdAt === "number" &&
    typeof obj.attempts === "number" &&
    typeof obj.dead === "boolean"
  );
}
