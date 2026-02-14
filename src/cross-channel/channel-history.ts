/**
 * Channel History Tracker (Hephie Phase 3.1)
 *
 * Tracks which channels a session has been active on,
 * with timestamps and message counts per channel.
 */

import type { ChannelHistoryEntry, ChannelType } from "./types.js";

/**
 * Manages channel history for a session.
 *
 * Thread-safe for single-session use (one ChannelHistoryTracker per session).
 * Persistence is handled externally (caller serializes to session store).
 */
export class ChannelHistoryTracker {
  private entries: Map<ChannelType, ChannelHistoryEntry>;

  constructor(initial?: ChannelHistoryEntry[]) {
    this.entries = new Map();
    if (initial) {
      for (const entry of initial) {
        this.entries.set(entry.channelType, { ...entry });
      }
    }
  }

  /**
   * Record a message on a channel. Creates or updates the history entry.
   */
  recordMessage(params: {
    channelType: ChannelType;
    timestamp?: number;
    topic?: string;
    channelUserId?: string;
    channelChatId?: string;
  }): ChannelHistoryEntry {
    const ts = params.timestamp ?? Date.now();
    const channelType = normalizeChannelType(params.channelType);

    const existing = this.entries.get(channelType);
    if (existing) {
      existing.lastMessageAt = Math.max(existing.lastMessageAt, ts);
      existing.firstMessageAt = Math.min(existing.firstMessageAt, ts);
      existing.messageCount += 1;
      if (params.topic) {
        existing.lastTopic = params.topic;
      }
      if (params.channelUserId) {
        existing.channelUserId = params.channelUserId;
      }
      if (params.channelChatId) {
        existing.channelChatId = params.channelChatId;
      }
      return { ...existing };
    }

    const entry: ChannelHistoryEntry = {
      channelType,
      firstMessageAt: ts,
      lastMessageAt: ts,
      messageCount: 1,
      lastTopic: params.topic,
      channelUserId: params.channelUserId,
      channelChatId: params.channelChatId,
    };
    this.entries.set(channelType, entry);
    return { ...entry };
  }

  /**
   * Get the history entry for a specific channel.
   */
  getChannel(channelType: ChannelType): ChannelHistoryEntry | undefined {
    const entry = this.entries.get(normalizeChannelType(channelType));
    return entry ? { ...entry } : undefined;
  }

  /**
   * Get all channel history entries, ordered by most recent activity.
   */
  getAllChannels(): ChannelHistoryEntry[] {
    return Array.from(this.entries.values())
      .map((e) => ({ ...e }))
      .toSorted((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  /**
   * Get channels OTHER than the specified one (for cross-channel context).
   */
  getOtherChannels(currentChannel: ChannelType): ChannelHistoryEntry[] {
    const normalized = normalizeChannelType(currentChannel);
    return this.getAllChannels().filter((e) => e.channelType !== normalized);
  }

  /**
   * Get the number of distinct channels this session spans.
   */
  getChannelCount(): number {
    return this.entries.size;
  }

  /**
   * Check if this session has activity on multiple channels.
   */
  isMultiChannel(): boolean {
    return this.entries.size > 1;
  }

  /**
   * Get the total message count across all channels.
   */
  getTotalMessages(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.messageCount;
    }
    return total;
  }

  /**
   * Serialize to a plain array for storage.
   */
  toJSON(): ChannelHistoryEntry[] {
    return this.getAllChannels();
  }

  /**
   * Create a tracker from serialized data.
   */
  static fromJSON(data: unknown): ChannelHistoryTracker {
    if (!Array.isArray(data)) {
      return new ChannelHistoryTracker();
    }
    const entries: ChannelHistoryEntry[] = [];
    for (const item of data) {
      if (isChannelHistoryEntry(item)) {
        entries.push(item);
      }
    }
    return new ChannelHistoryTracker(entries);
  }
}

/**
 * Normalize channel type string to lowercase.
 */
export function normalizeChannelType(raw: string): ChannelType {
  const trimmed = raw.trim().toLowerCase();
  // Map common aliases
  switch (trimmed) {
    case "tg":
    case "tele":
      return "telegram";
    case "wa":
      return "whatsapp";
    case "disc":
      return "discord";
    case "web":
      return "webchat";
    case "imsg":
    case "imessages":
      return "imessage";
    default:
      return trimmed;
  }
}

/**
 * Type guard for ChannelHistoryEntry.
 */
function isChannelHistoryEntry(value: unknown): value is ChannelHistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.channelType === "string" &&
    typeof obj.firstMessageAt === "number" &&
    typeof obj.lastMessageAt === "number" &&
    typeof obj.messageCount === "number"
  );
}
