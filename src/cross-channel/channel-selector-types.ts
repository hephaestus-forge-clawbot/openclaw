/**
 * Smart Channel Selection Types (Hephie Phase 3.4)
 *
 * Core types for intelligent outbound channel selection:
 * preference learning, availability tracking, affinity mapping,
 * and the selectBestChannel() API.
 */

import type { ChannelType } from "./types.js";

// ── Message Types ─────────────────────────────────────────────────────────

/** Well-known message content types for affinity mapping. */
export type KnownMessageType =
  | "text"
  | "code"
  | "file"
  | "image"
  | "document"
  | "acknowledgment"
  | "question"
  | "urgent"
  | "long-form"
  | "voice";

/** Message type — well-known or custom string. */
export type MessageType = KnownMessageType | (string & {});

/** Urgency levels for channel selection. */
export type UrgencyLevel = "low" | "normal" | "high" | "critical";

// ── User Availability ─────────────────────────────────────────────────────

/** Activity record for a user on a specific channel. */
export interface UserChannelActivity {
  /** Channel type. */
  channelType: ChannelType;

  /** Last time the user SENT a message on this channel (ms). */
  lastActiveAt: number;

  /** Total messages sent by user on this channel (rolling window). */
  messageCount: number;

  /** The channel-specific destination (chat ID, etc.) for reaching them. */
  destination?: string;

  /** Optional account ID for multi-account channels. */
  accountId?: string;
}

/** Staleness thresholds for availability detection. */
export interface StalenessThresholds {
  /** Channel is "active" if user was seen within this window (ms). Default: 5 min. */
  activeMs: number;

  /** Channel is "recent" if user was seen within this window (ms). Default: 1 hour. */
  recentMs: number;

  /** Channel is "stale" if user was seen within this window (ms). Default: 24 hours. */
  staleMs: number;

  /** Beyond staleMs, channel is considered "inactive". */
}

/** Default staleness thresholds. */
export const DEFAULT_STALENESS_THRESHOLDS: StalenessThresholds = {
  activeMs: 5 * 60 * 1000, // 5 minutes
  recentMs: 60 * 60 * 1000, // 1 hour
  staleMs: 24 * 60 * 60 * 1000, // 24 hours
};

/** Availability status for a user on a channel. */
export type AvailabilityStatus = "active" | "recent" | "stale" | "inactive" | "unknown";

/** Availability info for a user on a channel. */
export interface ChannelAvailability {
  channelType: ChannelType;
  status: AvailabilityStatus;
  lastActiveAt: number | null;
  /** Time since last activity in ms (null if never seen). */
  ageSinceActiveMs: number | null;
  /** Destination for reaching user on this channel. */
  destination?: string;
  accountId?: string;
}

// ── Channel Preferences ─────────────────────────────────────────────────

/** A learned preference pattern for a user. */
export interface ChannelPreference {
  /** Channel type. */
  channelType: ChannelType;

  /** Weight/score for this channel (higher = more preferred). */
  weight: number;

  /** Number of messages that contributed to this weight. */
  sampleSize: number;

  /** The message types commonly sent on this channel. */
  commonMessageTypes: MessageType[];

  /** Typical hours of activity (0-23). */
  activeHours: number[];
}

/** Per-user channel preferences (learned from history). */
export interface UserChannelPreferences {
  /** Canonical user name. */
  userId: string;

  /** Ranked channel preferences. */
  preferences: ChannelPreference[];

  /** When preferences were last computed. */
  computedAt: number;

  /** Total messages analyzed. */
  totalMessages: number;
}

// ── Affinity Mapping ────────────────────────────────────────────────────

/** Affinity rule: message type → preferred channels (ordered). */
export interface AffinityRule {
  /** The message type this rule applies to. */
  messageType: MessageType;

  /** Ordered list of preferred channels (first = most preferred). */
  preferredChannels: ChannelType[];

  /** Channels to avoid for this message type. */
  avoidChannels?: ChannelType[];

  /** Human-readable reason for this affinity. */
  reason: string;
}

/** Full affinity mapping configuration. */
export interface AffinityConfig {
  /** Rules for message type → channel mapping. */
  rules: AffinityRule[];

  /** Whether affinity rules override user preferences. */
  overridePreferences: boolean;

  /** Weight of affinity rules in final scoring (0-1). Default: 0.3. */
  affinityWeight: number;
}

/** Default affinity rules. */
export const DEFAULT_AFFINITY_RULES: AffinityRule[] = [
  {
    messageType: "code",
    preferredChannels: ["slack", "discord"],
    avoidChannels: ["whatsapp"],
    reason: "Better code formatting support",
  },
  {
    messageType: "acknowledgment",
    preferredChannels: [], // empty = use most recent channel
    reason: "Quick replies go to whatever channel is most recent",
  },
  {
    messageType: "file",
    preferredChannels: ["telegram", "slack", "discord"],
    avoidChannels: ["whatsapp"],
    reason: "No compression, better file handling",
  },
  {
    messageType: "image",
    preferredChannels: ["telegram", "slack"],
    avoidChannels: ["whatsapp"],
    reason: "No compression on images",
  },
  {
    messageType: "document",
    preferredChannels: ["slack", "telegram"],
    reason: "Better document sharing and formatting",
  },
  {
    messageType: "long-form",
    preferredChannels: ["slack", "telegram"],
    avoidChannels: ["whatsapp"],
    reason: "Better formatting for long content",
  },
  {
    messageType: "urgent",
    preferredChannels: [], // empty = use most recently active channel
    reason: "Urgent messages go to the channel with most recent activity",
  },
  {
    messageType: "voice",
    preferredChannels: ["telegram", "whatsapp"],
    reason: "Native voice message support",
  },
];

export const DEFAULT_AFFINITY_CONFIG: AffinityConfig = {
  rules: DEFAULT_AFFINITY_RULES,
  overridePreferences: false,
  affinityWeight: 0.3,
};

// ── Fallback Chain ──────────────────────────────────────────────────────

/** Per-user fallback chain configuration. */
export interface FallbackChain {
  /** Canonical user name. */
  userId: string;

  /** Ordered list of channels to try if primary fails. */
  channelOrder: ChannelType[];

  /** Optional destinations per channel (overrides stored ones). */
  destinations?: Partial<Record<string, string>>;

  /** Optional account IDs per channel. */
  accountIds?: Partial<Record<string, string>>;
}

// ── Channel Selection API ───────────────────────────────────────────────

/** Input to selectBestChannel(). */
export interface ChannelSelectionRequest {
  /** Canonical user ID / name. */
  userId: string;

  /** Message content type. */
  messageType?: MessageType;

  /** Urgency level. */
  urgency?: UrgencyLevel;

  /** If set, the current reply channel (from ReplyRouter). */
  currentReplyChannel?: ChannelType;

  /** Explicit override — force this channel. */
  forceChannel?: ChannelType;

  /** Current timestamp (for testing). */
  now?: number;
}

/** A single channel recommendation with score and reasoning. */
export interface ChannelRecommendation {
  /** The recommended channel. */
  channel: ChannelType;

  /** Combined score (0-1, higher = better). */
  score: number;

  /** Destination for reaching user on this channel. */
  destination?: string;

  /** Optional account ID. */
  accountId?: string;

  /** Human-readable reasons for this recommendation. */
  reasons: string[];
}

/** Result of selectBestChannel(). */
export interface ChannelSelectionResult {
  /** Ranked list of channel recommendations (best first). */
  recommendations: ChannelRecommendation[];

  /** The top recommendation (convenience). */
  best: ChannelRecommendation | null;

  /** Whether the selection overrides the default reply channel. */
  overridesReplyChannel: boolean;

  /** Human-readable summary of the selection reasoning. */
  reasoning: string;
}

// ── Smart Channel Selector Config ───────────────────────────────────────

/** Configuration for the SmartChannelSelector. */
export interface SmartChannelSelectorConfig {
  /** Staleness thresholds for availability detection. */
  stalenessThresholds: StalenessThresholds;

  /** Affinity mapping configuration. */
  affinity: AffinityConfig;

  /** Weight factors for scoring components (all 0-1, should sum to ~1). */
  weights: {
    /** Weight for user preference score. Default: 0.3. */
    preference: number;
    /** Weight for availability score. Default: 0.3. */
    availability: number;
    /** Weight for affinity score. Default: 0.2. */
    affinity: number;
    /** Weight for recency (reply channel) score. Default: 0.2. */
    recency: number;
  };

  /** Whether to override reply channel based on smart selection. */
  enableOverride: boolean;

  /** Minimum score difference to justify overriding reply channel. */
  overrideThreshold: number;
}

/** Default configuration for SmartChannelSelector. */
export const DEFAULT_SELECTOR_CONFIG: SmartChannelSelectorConfig = {
  stalenessThresholds: DEFAULT_STALENESS_THRESHOLDS,
  affinity: DEFAULT_AFFINITY_CONFIG,
  weights: {
    preference: 0.3,
    availability: 0.3,
    affinity: 0.2,
    recency: 0.2,
  },
  enableOverride: true,
  overrideThreshold: 0.25,
};
