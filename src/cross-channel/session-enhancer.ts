/**
 * Session Model Enhancer (Hephie Phase 3.1)
 *
 * Enhances the existing SessionEntry model with channel history tracking.
 * Works with the existing session store — adds channelHistory as a new
 * field on SessionEntry without breaking existing functionality.
 */

import type { ChannelHistoryEntry, ChannelType } from "./types.js";
import { ChannelHistoryTracker } from "./channel-history.js";
import { normalizeChannelType } from "./channel-history.js";

/**
 * Extended session fields added by cross-channel intelligence.
 * These are merged into the existing SessionEntry type.
 */
export interface CrossChannelSessionFields {
  /** History of channels this session has been active on. */
  channelHistory?: ChannelHistoryEntry[];

  /** The canonical person name for this session (for identity mapping). */
  crossChannelPerson?: string;
}

/**
 * Update channel history on a session entry when a message arrives.
 *
 * @param currentHistory - The current channel history (from session store), or undefined.
 * @param params - The message parameters.
 * @returns Updated channel history entries to persist.
 */
export function updateChannelHistory(
  currentHistory: ChannelHistoryEntry[] | undefined,
  params: {
    channelType: string;
    timestamp?: number;
    topic?: string;
    channelUserId?: string;
    channelChatId?: string;
  },
): ChannelHistoryEntry[] {
  const tracker = ChannelHistoryTracker.fromJSON(currentHistory);

  tracker.recordMessage({
    channelType: normalizeChannelType(params.channelType),
    timestamp: params.timestamp,
    topic: params.topic,
    channelUserId: params.channelUserId,
    channelChatId: params.channelChatId,
  });

  return tracker.toJSON();
}

/**
 * Extract channel type from session entry fields.
 *
 * Examines the session's channel, origin.provider, origin.surface, etc.
 * to determine the channel type.
 */
export function extractChannelType(sessionFields: {
  channel?: string;
  lastChannel?: string;
  origin?: { provider?: string; surface?: string };
}): ChannelType | undefined {
  // Try direct channel field first
  const channel = sessionFields.channel ?? sessionFields.lastChannel;
  if (channel) {
    return normalizeChannelType(channel);
  }

  // Try origin fields
  const provider = sessionFields.origin?.provider;
  if (provider) {
    return normalizeChannelType(provider);
  }

  const surface = sessionFields.origin?.surface;
  if (surface) {
    return normalizeChannelType(surface);
  }

  return undefined;
}

/**
 * Extract the sender identity from a message context.
 *
 * Returns channel type + user ID for identity mapping.
 */
export function extractSenderIdentity(ctx: {
  Surface?: string;
  Provider?: string;
  OriginatingChannel?: string;
  SenderId?: string;
  SenderE164?: string;
  From?: string;
}): { channelType: ChannelType; userId: string } | undefined {
  const channelRaw = ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider;
  if (!channelRaw) {
    return undefined;
  }

  const channelType = normalizeChannelType(channelRaw);

  // Try SenderId first (most specific)
  const senderId = ctx.SenderId?.trim();
  if (senderId) {
    return { channelType, userId: senderId };
  }

  // Try E164 for WhatsApp/Signal
  const e164 = ctx.SenderE164?.trim();
  if (e164 && (channelType === "whatsapp" || channelType === "signal")) {
    return { channelType, userId: e164 };
  }

  // Try From as fallback
  const from = ctx.From?.trim();
  if (from) {
    return { channelType, userId: from };
  }

  return undefined;
}

/**
 * Check if two session entries likely belong to the same person.
 *
 * Uses channel history and identity mapping to determine if sessions
 * on different channels belong to the same person.
 */
export function sessionsMatchPerson(
  session1: { channelHistory?: ChannelHistoryEntry[]; crossChannelPerson?: string },
  session2: { channelHistory?: ChannelHistoryEntry[]; crossChannelPerson?: string },
): boolean {
  // Direct match on crossChannelPerson
  if (
    session1.crossChannelPerson &&
    session2.crossChannelPerson &&
    session1.crossChannelPerson.toLowerCase() === session2.crossChannelPerson.toLowerCase()
  ) {
    return true;
  }

  // Check if channel histories share user IDs
  const history1 = session1.channelHistory ?? [];
  const history2 = session2.channelHistory ?? [];

  for (const h1 of history1) {
    for (const h2 of history2) {
      if (
        h1.channelType === h2.channelType &&
        h1.channelUserId &&
        h2.channelUserId &&
        h1.channelUserId === h2.channelUserId
      ) {
        return true;
      }
    }
  }

  return false;
}
