/**
 * Cross-Channel Context Bridge (Hephie Phase 3.1)
 *
 * Bridges context between channels. When a message arrives on one channel,
 * this module checks for relevant activity on other channels and assembles
 * cross-channel context for injection into the LLM prompt.
 */

import type { ChannelHistoryTracker } from "./channel-history.js";
import type { IdentityStore } from "./identity-map.js";
import type { ChannelHistoryEntry, ChannelType } from "./types.js";
import type { CrossChannelConfig, CrossChannelContext, CrossChannelContextEntry } from "./types.js";
import { DEFAULT_CROSS_CHANNEL_CONFIG } from "./types.js";

/**
 * Session info needed for cross-channel lookups.
 */
export interface SessionInfo {
  /** The session key. */
  sessionKey: string;

  /** The channel history tracker for this session. */
  channelHistory: ChannelHistoryTracker;

  /** The person this session belongs to. */
  person?: string;

  /** Last known topic in this session. */
  lastTopic?: string;
}

/**
 * Assembles cross-channel context for a given user and channel.
 *
 * @param params - The context assembly parameters.
 * @returns The assembled cross-channel context.
 */
export function assembleCrossChannelContext(params: {
  /** The canonical user name. */
  currentUser: string;

  /** The channel the current message is on. */
  currentChannel: ChannelType;

  /** All active sessions (for looking up cross-channel activity). */
  activeSessions: SessionInfo[];

  /** The identity store for user lookups. */
  identityStore: IdentityStore;

  /** Configuration override. */
  config?: Partial<CrossChannelConfig>;

  /** Current timestamp for age filtering. */
  now?: number;
}): CrossChannelContext {
  const config = { ...DEFAULT_CROSS_CHANNEL_CONFIG, ...params.config };
  const now = params.now ?? Date.now();

  const result: CrossChannelContext = {
    currentUser: params.currentUser,
    currentChannel: params.currentChannel,
    otherChannelActivity: [],
    enabled: config.enabled,
    formattedContext: "",
  };

  if (!config.enabled) {
    return result;
  }

  // Find sessions belonging to this user on other channels
  const userSessions = findUserSessions(params.currentUser, params.activeSessions);

  // Collect activity from other channels
  const entries: CrossChannelContextEntry[] = [];

  for (const session of userSessions) {
    const otherChannels = session.channelHistory.getOtherChannels(params.currentChannel);

    for (const channel of otherChannels) {
      // Skip if too old
      if (now - channel.lastMessageAt > config.maxAgeMs) {
        continue;
      }

      const entry: CrossChannelContextEntry = {
        channelType: channel.channelType,
        timestamp: channel.lastMessageAt,
        summary: buildChannelSummary(channel, session),
        sessionKey: session.sessionKey,
        relevance: computeRelevance(channel, now, config.maxAgeMs),
      };

      if (entry.relevance >= config.minRelevance) {
        entries.push(entry);
      }
    }
  }

  // Sort by relevance (descending), then by recency
  entries.sort((a, b) => {
    const relDiff = b.relevance - a.relevance;
    if (Math.abs(relDiff) > 0.01) {
      return relDiff;
    }
    return b.timestamp - a.timestamp;
  });

  // Cap to maxEntries
  result.otherChannelActivity = entries.slice(0, config.maxEntries);

  // Format the context string
  result.formattedContext = formatCrossChannelContext(result);

  return result;
}

/**
 * Find all sessions that belong to a specific user.
 */
function findUserSessions(canonicalName: string, sessions: SessionInfo[]): SessionInfo[] {
  const name = canonicalName.toLowerCase().trim();
  return sessions.filter((s) => s.person?.toLowerCase().trim() === name);
}

/**
 * Build a human-readable summary for a channel's activity.
 */
function buildChannelSummary(channel: ChannelHistoryEntry, session: SessionInfo): string {
  const parts: string[] = [];

  if (channel.lastTopic) {
    parts.push(channel.lastTopic);
  } else if (session.lastTopic) {
    parts.push(session.lastTopic);
  }

  if (channel.messageCount > 0) {
    parts.push(`${channel.messageCount} message${channel.messageCount === 1 ? "" : "s"}`);
  }

  if (parts.length === 0) {
    return `active on ${channel.channelType}`;
  }

  return parts.join(" — ");
}

/**
 * Compute relevance score based on recency.
 * More recent activity = higher relevance.
 */
function computeRelevance(channel: ChannelHistoryEntry, now: number, maxAgeMs: number): number {
  const ageMs = now - channel.lastMessageAt;
  if (ageMs <= 0) {
    return 1.0;
  }
  if (ageMs >= maxAgeMs) {
    return 0.0;
  }
  // Linear decay from 1.0 to 0.0 over maxAgeMs
  return 1.0 - ageMs / maxAgeMs;
}

/**
 * Format cross-channel context into a human-readable string for injection.
 */
export function formatCrossChannelContext(context: CrossChannelContext): string {
  if (!context.enabled || context.otherChannelActivity.length === 0) {
    return "";
  }

  const lines: string[] = [`[Cross-Channel Context for ${context.currentUser}]`];

  for (const entry of context.otherChannelActivity) {
    const channelLabel = entry.channelType.charAt(0).toUpperCase() + entry.channelType.slice(1);
    const timeAgo = formatTimeAgo(entry.timestamp);
    lines.push(`- ${channelLabel} (${timeAgo}): ${entry.summary}`);
  }

  return lines.join("\n");
}

/**
 * Format a timestamp as a relative time string.
 */
function formatTimeAgo(timestampMs: number): string {
  const now = Date.now();
  const diffMs = now - timestampMs;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMin / 60);

  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${Math.floor(diffHours / 24)}d ago`;
}
