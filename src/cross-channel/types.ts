/**
 * Cross-Channel Intelligence Types (Hephie Phase 3.1)
 *
 * Core types for unified session context, user identity mapping,
 * and cross-channel context injection.
 */

// ── Channel History ─────────────────────────────────────────────────────

/** Supported channel types for cross-channel tracking. */
export type ChannelType =
  | "telegram"
  | "slack"
  | "discord"
  | "whatsapp"
  | "imessage"
  | "signal"
  | "webchat"
  | "line"
  | string; // Allow extension

/** A record of activity on a single channel within a session. */
export interface ChannelHistoryEntry {
  /** Channel type (e.g., "telegram", "slack"). */
  channelType: ChannelType;

  /** Timestamp (ms) of the first message on this channel. */
  firstMessageAt: number;

  /** Timestamp (ms) of the last message on this channel. */
  lastMessageAt: number;

  /** Number of messages exchanged on this channel in this session. */
  messageCount: number;

  /** Optional topic/summary of what was discussed on this channel. */
  lastTopic?: string;

  /** The channel-specific user ID (e.g., Telegram user ID, Slack user ID). */
  channelUserId?: string;

  /** The channel-specific chat/conversation ID. */
  channelChatId?: string;
}

// ── User Identity ───────────────────────────────────────────────────────

/** A single identity mapping for a user on a specific channel. */
export interface ChannelIdentity {
  /** Channel type. */
  channelType: ChannelType;

  /** The user's ID on this channel. */
  userId: string;

  /** Optional username/handle on this channel. */
  username?: string;

  /** Optional display name on this channel. */
  displayName?: string;

  /** When this identity was first seen. */
  firstSeen?: number;

  /** When this identity was last active. */
  lastSeen?: number;
}

/** Full identity mapping for a user across all channels. */
export interface UserIdentityMap {
  /** The canonical name for this person (matches memory/people/<name>.md). */
  canonicalName: string;

  /** All known channel identities. */
  identities: ChannelIdentity[];

  /** When this mapping was created. */
  createdAt: number;

  /** When this mapping was last updated. */
  updatedAt: number;
}

// ── Cross-Channel Context ───────────────────────────────────────────────

/** A summary of activity on another channel, for context injection. */
export interface CrossChannelContextEntry {
  /** The channel where the activity happened. */
  channelType: ChannelType;

  /** When the activity happened (most recent message). */
  timestamp: number;

  /** Brief summary of what was discussed. */
  summary: string;

  /** The session key where this happened. */
  sessionKey: string;

  /** Relevance score (0-1) for the current conversation. */
  relevance: number;
}

/** The assembled cross-channel context for injection. */
export interface CrossChannelContext {
  /** The user we're currently talking to. */
  currentUser: string;

  /** The current channel. */
  currentChannel: ChannelType;

  /** Activity on other channels. */
  otherChannelActivity: CrossChannelContextEntry[];

  /** Whether cross-channel context injection is enabled. */
  enabled: boolean;

  /** The formatted context string for injection. */
  formattedContext: string;
}

// ── Configuration ───────────────────────────────────────────────────────

/** Configuration for cross-channel intelligence features. */
export interface CrossChannelConfig {
  /** Whether cross-channel context injection is enabled (default: true). */
  enabled: boolean;

  /** Maximum number of cross-channel entries to inject (default: 3). */
  maxEntries: number;

  /** Maximum age (ms) of cross-channel context to consider (default: 24h). */
  maxAgeMs: number;

  /** Whether to respect privacy compartments (default: true). */
  respectPrivacy: boolean;

  /** Minimum relevance score to include (default: 0.1). */
  minRelevance: number;
}

/** Default cross-channel configuration. */
export const DEFAULT_CROSS_CHANNEL_CONFIG: CrossChannelConfig = {
  enabled: true,
  maxEntries: 3,
  maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
  respectPrivacy: true,
  minRelevance: 0.1,
};
