/**
 * Cross-Channel Sender (Hephie Phase 3.2)
 *
 * Internal API for sending messages to any configured channel.
 * Supports direct send, queued send (with retry), and broadcast.
 *
 * This is the core capability that enables proactive messaging —
 * the agent can decide to send a message on any channel at any time.
 */

import type { MessageQueue } from "./message-queue.js";
import type { ChannelType } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Channel send function signature.
 * Each channel provider implements this to actually deliver a message.
 */
export type ChannelSendFn = (params: {
  to: string;
  message: string;
  accountId?: string;
  threadId?: string | number;
}) => Promise<SendResult>;

/**
 * Result of a send attempt.
 */
export interface SendResult {
  /** Whether the send succeeded. */
  success: boolean;

  /** The message ID returned by the channel (if successful). */
  messageId?: string;

  /** Error message (if failed). */
  error?: string;

  /** The channel the message was sent on. */
  channel: ChannelType;

  /** The destination. */
  to: string;
}

/**
 * Result of a broadcast attempt.
 */
export interface BroadcastResult {
  /** Individual results per channel. */
  results: SendResult[];

  /** Number of successful sends. */
  successCount: number;

  /** Number of failed sends. */
  failureCount: number;
}

/**
 * Options for sending a message.
 */
export interface SendOptions {
  /** Target channel. */
  channel: ChannelType;

  /** Destination (chat ID, user ID, etc.). */
  to: string;

  /** Message text. */
  message: string;

  /** Optional account ID for multi-account channels. */
  accountId?: string;

  /** Optional thread ID. */
  threadId?: string | number;

  /** If true, queue the message for retry on failure instead of failing immediately. */
  queueOnFailure?: boolean;

  /** Optional metadata to attach to the queued message. */
  metadata?: Record<string, unknown>;
}

/**
 * Options for broadcasting a message.
 */
export interface BroadcastOptions {
  /** Message text. */
  message: string;

  /** If specified, only broadcast to these channels. */
  channels?: ChannelType[];

  /** If true, queue failed sends for retry. */
  queueOnFailure?: boolean;

  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for a registered channel target (for broadcast).
 */
export interface ChannelTarget {
  /** Channel type. */
  channel: ChannelType;

  /** Default destination for broadcast. */
  defaultTo: string;

  /** Optional account ID. */
  accountId?: string;
}

// ── Sender Implementation ─────────────────────────────────────────────────

export class CrossChannelSender {
  /** channel → send function */
  private senders: Map<ChannelType, ChannelSendFn> = new Map();

  /** channel → default broadcast targets */
  private broadcastTargets: Map<ChannelType, ChannelTarget> = new Map();

  /** Optional message queue for retry logic */
  private queue: MessageQueue | null = null;

  /**
   * Register a channel's send function.
   */
  registerChannel(channel: ChannelType, sendFn: ChannelSendFn): void {
    this.senders.set(channel, sendFn);
  }

  /**
   * Register a broadcast target for a channel.
   */
  registerBroadcastTarget(target: ChannelTarget): void {
    this.broadcastTargets.set(target.channel, target);
  }

  /**
   * Set the message queue for retry logic.
   */
  setMessageQueue(queue: MessageQueue): void {
    this.queue = queue;
  }

  /**
   * Check if a channel has a registered sender.
   */
  hasChannel(channel: ChannelType): boolean {
    return this.senders.has(channel);
  }

  /**
   * Get all registered channel types.
   */
  getRegisteredChannels(): ChannelType[] {
    return Array.from(this.senders.keys());
  }

  /**
   * Get all broadcast targets.
   */
  getBroadcastTargets(): ChannelTarget[] {
    return Array.from(this.broadcastTargets.values()).map((t) => ({ ...t }));
  }

  /**
   * Send a message to a specific channel.
   */
  async send(options: SendOptions): Promise<SendResult> {
    const sendFn = this.senders.get(options.channel);
    if (!sendFn) {
      const result: SendResult = {
        success: false,
        error: `No sender registered for channel: ${options.channel}`,
        channel: options.channel,
        to: options.to,
      };

      // Queue for retry if requested
      if (options.queueOnFailure && this.queue) {
        await this.queue.enqueue({
          channel: options.channel,
          to: options.to,
          message: options.message,
          accountId: options.accountId,
          threadId: options.threadId,
          metadata: options.metadata,
        });
      }

      return result;
    }

    try {
      const result = await sendFn({
        to: options.to,
        message: options.message,
        accountId: options.accountId,
        threadId: options.threadId,
      });

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const result: SendResult = {
        success: false,
        error: errorMsg,
        channel: options.channel,
        to: options.to,
      };

      // Queue for retry if requested
      if (options.queueOnFailure && this.queue) {
        await this.queue.enqueue({
          channel: options.channel,
          to: options.to,
          message: options.message,
          accountId: options.accountId,
          threadId: options.threadId,
          metadata: options.metadata,
        });
      }

      return result;
    }
  }

  /**
   * Broadcast a message to all registered broadcast targets
   * (or a subset if channels are specified).
   */
  async broadcast(options: BroadcastOptions): Promise<BroadcastResult> {
    const targets = options.channels
      ? Array.from(this.broadcastTargets.values()).filter((t) =>
          options.channels!.includes(t.channel),
        )
      : Array.from(this.broadcastTargets.values());

    const results: SendResult[] = [];

    // Send to all targets in parallel
    const promises = targets.map(async (target) => {
      const result = await this.send({
        channel: target.channel,
        to: target.defaultTo,
        message: options.message,
        accountId: target.accountId,
        queueOnFailure: options.queueOnFailure,
        metadata: options.metadata,
      });
      results.push(result);
    });

    await Promise.all(promises);

    return {
      results,
      successCount: results.filter((r) => r.success).length,
      failureCount: results.filter((r) => !r.success).length,
    };
  }

  /**
   * Process the retry queue — attempt to deliver queued messages.
   * Returns the number of messages successfully delivered.
   */
  async processQueue(now?: number): Promise<number> {
    if (!this.queue) {
      return 0;
    }

    const pending = this.queue.getPendingMessages(now);
    let delivered = 0;

    for (const msg of pending) {
      const sendFn = this.senders.get(msg.channel);
      if (!sendFn) {
        await this.queue.markFailed(msg.id, `No sender for channel: ${msg.channel}`);
        continue;
      }

      try {
        const result = await sendFn({
          to: msg.to,
          message: msg.message,
          accountId: msg.accountId,
          threadId: msg.threadId,
        });

        if (result.success) {
          await this.queue.markDelivered(msg.id);
          delivered++;
        } else {
          await this.queue.markFailed(msg.id, result.error ?? "Send failed");
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.queue.markFailed(msg.id, errorMsg);
      }
    }

    return delivered;
  }

  /**
   * Clear all registered channels and targets.
   */
  clear(): void {
    this.senders.clear();
    this.broadcastTargets.clear();
  }
}
