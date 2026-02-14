/**
 * Message Path Hooks (Hephie Phase 3.2)
 *
 * Hooks that wire Phase 3.1's cross-channel intelligence into the live
 * message processing path. Two integration points:
 *
 * 1. **Inbound hook**: Called when a message arrives on any channel.
 *    Updates channel history on the session and reply routing.
 *
 * 2. **Prompt hook**: Called during system prompt assembly.
 *    Injects cross-channel context into the LLM's system prompt.
 */

import type { ContextSection } from "../memory/context-injector.js";
import type { ReplyRoute } from "./reply-router.js";
import type { ChannelHistoryEntry, ChannelType, CrossChannelConfig } from "./types.js";
import { ChannelHistoryTracker } from "./channel-history.js";
import { assembleCrossChannelContext, type SessionInfo } from "./context-bridge.js";
import {
  buildCrossChannelSection,
  shouldInjectCrossChannelContext,
} from "./context-injector-integration.js";
import { IdentityStore } from "./identity-map.js";
import { ReplyRouter } from "./reply-router.js";
import {
  updateChannelHistory,
  extractChannelType,
  extractSenderIdentity,
} from "./session-enhancer.js";
import { DEFAULT_CROSS_CHANNEL_CONFIG } from "./types.js";

// ── Inbound Message Hook ──────────────────────────────────────────────────

/**
 * Parameters for the inbound message hook.
 */
export interface InboundHookParams {
  /** The session key (from session store). */
  sessionKey: string;

  /** The current channel history on the session (may be undefined for new sessions). */
  currentChannelHistory?: ChannelHistoryEntry[];

  /** The channel the message arrived on. */
  channelType: string;

  /** The channel-specific user ID (e.g., telegram user ID). */
  channelUserId?: string;

  /** The channel-specific chat/conversation ID. */
  channelChatId?: string;

  /** The destination address (for reply routing). */
  to?: string;

  /** The account ID (for multi-account channels). */
  accountId?: string;

  /** Thread ID (for threaded conversations). */
  threadId?: string | number;

  /** The canonical person name (if known). */
  person?: string;

  /** Optional topic of the current message. */
  topic?: string;

  /** Timestamp override. */
  timestamp?: number;
}

/**
 * Result of the inbound message hook.
 */
export interface InboundHookResult {
  /** Updated channel history to persist on the session. */
  channelHistory: ChannelHistoryEntry[];

  /** The reply route for this session. */
  replyRoute: ReplyRoute;
}

/**
 * Process an inbound message — updates channel history and reply routing.
 *
 * This is the main integration point for wiring Phase 3.1 into the
 * live message processing path. Call this from each channel's message
 * handler (telegram, slack, discord, etc.) after `recordInboundSession`.
 */
export function processInboundForCrossChannel(
  params: InboundHookParams,
  router: ReplyRouter,
): InboundHookResult {
  // 1. Update channel history
  const channelHistory = updateChannelHistory(params.currentChannelHistory, {
    channelType: params.channelType,
    timestamp: params.timestamp,
    topic: params.topic,
    channelUserId: params.channelUserId,
    channelChatId: params.channelChatId,
  });

  // 2. Update reply routing
  const replyRoute = router.updateRoute({
    sessionKey: params.sessionKey,
    channel: params.channelType as ChannelType,
    to: params.to ?? params.channelChatId ?? "",
    accountId: params.accountId,
    threadId: params.threadId,
    person: params.person,
    timestamp: params.timestamp,
  });

  return { channelHistory, replyRoute };
}

// ── Prompt Assembly Hook ──────────────────────────────────────────────────

/**
 * Parameters for the prompt assembly hook.
 */
export interface PromptHookParams {
  /** The current user/person name. */
  currentPerson?: string;

  /** The current channel. */
  currentChannel?: string;

  /** The session key. */
  sessionKey: string;

  /** Function to look up all sessions from the session store. */
  getSessionEntries?: () => Array<{
    key: string;
    channelHistory?: ChannelHistoryEntry[];
    crossChannelPerson?: string;
    lastTopic?: string;
  }>;

  /** Cross-channel config override. */
  config?: Partial<CrossChannelConfig>;
}

/**
 * Result of the prompt assembly hook.
 */
export interface PromptHookResult {
  /** The context section to inject (or null if nothing to inject). */
  section: ContextSection | null;

  /** The raw cross-channel context (for debugging/logging). */
  formattedContext: string;
}

/**
 * Assemble cross-channel context for system prompt injection.
 *
 * This is the second integration point — call during system prompt
 * assembly to include cross-channel activity context.
 */
export function assembleCrossChannelPromptSection(params: PromptHookParams): PromptHookResult {
  const emptyResult: PromptHookResult = { section: null, formattedContext: "" };

  if (!params.currentPerson || !params.currentChannel) {
    return emptyResult;
  }

  const config = { ...DEFAULT_CROSS_CHANNEL_CONFIG, ...params.config };

  if (
    !shouldInjectCrossChannelContext({
      enabled: config.enabled,
      currentPerson: params.currentPerson,
      crossChannelPerson: params.currentPerson,
      respectPrivacy: config.respectPrivacy,
    })
  ) {
    return emptyResult;
  }

  // Build session info from the session store
  const sessionEntries = params.getSessionEntries?.() ?? [];
  const activeSessions: SessionInfo[] = sessionEntries.map((entry) => ({
    sessionKey: entry.key,
    channelHistory: ChannelHistoryTracker.fromJSON(entry.channelHistory),
    person: entry.crossChannelPerson,
    lastTopic: entry.lastTopic,
  }));

  // We need an identity store — for now, create a simple one
  const identityStore = new IdentityStore();

  const crossChannelContext = assembleCrossChannelContext({
    currentUser: params.currentPerson,
    currentChannel: params.currentChannel as ChannelType,
    activeSessions,
    identityStore,
    config,
  });

  const section = buildCrossChannelSection(crossChannelContext);
  const formattedContext = crossChannelContext.formattedContext;

  return { section, formattedContext };
}

// ── Convenience: Extract identity from message context ────────────────────

/**
 * Extract channel and identity info from a message context object.
 * Works with the common MsgContext shape used across channels.
 */
export function extractMessageIdentity(ctx: {
  Surface?: string;
  Provider?: string;
  OriginatingChannel?: string;
  SenderId?: string;
  SenderE164?: string;
  From?: string;
  ChatId?: string;
  AccountId?: string;
  ThreadId?: string | number;
  MessageThreadId?: string | number;
}): {
  channelType: string | undefined;
  channelUserId: string | undefined;
  channelChatId: string | undefined;
  accountId: string | undefined;
  threadId: string | number | undefined;
} {
  const identity = extractSenderIdentity(ctx);
  const channelType = extractChannelType({
    channel: ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider,
  });

  return {
    channelType: channelType ?? identity?.channelType,
    channelUserId: identity?.userId,
    channelChatId: ctx.ChatId ?? (ctx.OriginatingChannel ? undefined : undefined),
    accountId: ctx.AccountId,
    threadId: ctx.ThreadId ?? ctx.MessageThreadId,
  };
}
