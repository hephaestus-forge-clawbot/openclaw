/**
 * Thread-Aware Context Injection (Hephie Phase 3.3)
 *
 * When composing a reply, includes relevant messages from the unified thread
 * regardless of which channel they came from. Budget-aware, recency-weighted,
 * and privacy-aware.
 */

import type { ThreadStore } from "./thread-store.js";
import type {
  UnifiedThread,
  ThreadMessage,
  ThreadConfig,
  ThreadContextInjection,
} from "./thread-types.js";
import type { ChannelType } from "./types.js";
import { DEFAULT_THREAD_CONFIG } from "./thread-types.js";

/**
 * Rough token estimation: ~4 chars per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Parameters for assembling thread context.
 */
export interface ThreadContextParams {
  /** The current channel the message is on. */
  currentChannel: ChannelType;

  /** The person we're talking to (canonical name). */
  currentPerson: string;

  /** Total token budget for the entire context. */
  totalTokenBudget: number;

  /** Unified thread to pull context from (if known). */
  threadId?: string;

  /** Multiple thread IDs to consider. */
  threadIds?: string[];

  /** Current timestamp. */
  now?: number;

  /** Configuration override. */
  config?: Partial<ThreadConfig>;

  /** Privacy filter: only include messages from these participants. */
  allowedParticipants?: string[];
}

/**
 * Assemble thread-aware context for injection into the LLM prompt.
 *
 * Selects messages from the unified thread that are:
 * - Within the token budget (configurable fraction of total budget)
 * - Recency-weighted (newer messages get priority)
 * - From other channels (cross-channel context)
 * - Privacy-respecting (only from allowed participants)
 */
export function assembleThreadContext(
  store: ThreadStore,
  params: ThreadContextParams,
): ThreadContextInjection[] {
  const config = { ...DEFAULT_THREAD_CONFIG, ...params.config };
  const now = params.now ?? Date.now();

  if (!config.enabled) {
    return [];
  }

  // Calculate thread context budget
  const threadBudget = Math.floor(params.totalTokenBudget * config.contextBudgetFraction);
  if (threadBudget <= 0) {
    return [];
  }

  // Collect thread IDs to process
  const threadIds = new Set<string>();
  if (params.threadId) {
    threadIds.add(params.threadId);
  }
  if (params.threadIds) {
    for (const id of params.threadIds) {
      threadIds.add(id);
    }
  }

  // If no specific threads given, find active threads for this person
  if (threadIds.size === 0) {
    const activeThreads = store.getActiveThreadsForParticipant(params.currentPerson);
    for (const t of activeThreads) {
      threadIds.add(t.threadId);
    }
  }

  if (threadIds.size === 0) {
    return [];
  }

  const injections: ThreadContextInjection[] = [];
  let remainingBudget = threadBudget;

  // Process each thread
  for (const threadId of threadIds) {
    if (remainingBudget <= 20) {
      break;
    } // Not enough budget for meaningful context

    const thread = store.getThreadWithMessages(threadId);
    if (!thread || !thread.messages || thread.messages.length === 0) {
      continue;
    }

    const injection = buildInjection(
      thread,
      params.currentChannel,
      params.currentPerson,
      remainingBudget,
      config,
      now,
      params.allowedParticipants,
    );

    if (injection && injection.messages.length > 0) {
      injections.push(injection);
      remainingBudget -= injection.estimatedTokens;
    }
  }

  return injections;
}

/**
 * Build a context injection for a single thread.
 */
function buildInjection(
  thread: UnifiedThread,
  currentChannel: ChannelType,
  currentPerson: string,
  budget: number,
  config: ThreadConfig,
  now: number,
  allowedParticipants?: string[],
): ThreadContextInjection | null {
  if (!thread.messages || thread.messages.length === 0) {
    return null;
  }

  // Filter messages
  let candidates = thread.messages.filter((msg) => {
    // Privacy: only include messages from allowed participants
    if (config.respectPrivacy && allowedParticipants) {
      if (!allowedParticipants.includes(msg.sender)) {
        return false;
      }
    }
    return true;
  });

  // Score and sort by recency-weighted relevance
  const scored = candidates.map((msg) => ({
    msg,
    score: scoreMessage(msg, currentChannel, now),
    isCrossChannel: msg.channelType !== currentChannel,
  }));

  // Sort: cross-channel first (higher relevance), then by score
  scored.sort((a, b) => {
    // Cross-channel messages get priority
    if (a.isCrossChannel && !b.isCrossChannel) {
      return -1;
    }
    if (!a.isCrossChannel && b.isCrossChannel) {
      return 1;
    }
    return b.score - a.score;
  });

  // Select messages within budget
  const selected: ThreadMessage[] = [];
  let usedTokens = 0;
  const headerTokens = estimateTokens(`[Thread: ${thread.topic ?? "conversation"}]\n`);
  usedTokens += headerTokens;

  const maxMessages = Math.min(config.maxContextMessages, scored.length);

  for (const item of scored) {
    if (selected.length >= maxMessages) {
      break;
    }

    const msgTokens = estimateTokens(formatMessage(item.msg));
    if (usedTokens + msgTokens > budget) {
      continue;
    } // Skip if too large

    selected.push(item.msg);
    usedTokens += msgTokens;
  }

  if (selected.length === 0) {
    return null;
  }

  // Re-sort selected by timestamp for chronological presentation
  selected.sort((a, b) => a.timestamp - b.timestamp);

  const channels = [...new Set(selected.map((m) => m.channelType))];
  const formattedContext = formatThreadContext(thread, selected);

  return {
    threadId: thread.threadId,
    topic: thread.topic,
    messages: selected,
    channels,
    estimatedTokens: usedTokens,
    formattedContext,
  };
}

/**
 * Score a message for context injection priority.
 * Higher score = more relevant.
 */
function scoreMessage(msg: ThreadMessage, currentChannel: ChannelType, now: number): number {
  let score = 0;

  // Recency: exponential decay, half-life of 1 hour
  const ageMs = now - msg.timestamp;
  const halfLifeMs = 60 * 60 * 1000; // 1 hour
  score += Math.exp(-ageMs / halfLifeMs) * 0.5;

  // Cross-channel bonus
  if (msg.channelType !== currentChannel) {
    score += 0.3;
  }

  // Content length bonus (longer messages = more substantial)
  const contentLength = msg.content.length;
  if (contentLength > 100) {
    score += 0.1;
  } else if (contentLength > 50) {
    score += 0.05;
  }

  // Link type bonus
  if (msg.linkType === "explicit") {
    score += 0.1;
  }

  return score;
}

/**
 * Format a single message for context injection.
 */
function formatMessage(msg: ThreadMessage): string {
  const channelLabel = msg.channelType.charAt(0).toUpperCase() + msg.channelType.slice(1);
  const timeStr = formatRelativeTime(msg.timestamp);
  return `[${channelLabel}] ${msg.sender} (${timeStr}): ${msg.content}`;
}

/**
 * Format the full thread context for injection.
 */
function formatThreadContext(thread: UnifiedThread, messages: ThreadMessage[]): string {
  const lines: string[] = [];

  // Header
  const topicStr = thread.topic ? ` — ${thread.topic}` : "";
  const channelList = [...new Set(messages.map((m) => m.channelType))].join(", ");
  lines.push(`[Cross-Channel Thread${topicStr}] (spanning: ${channelList})`);

  // Messages
  for (const msg of messages) {
    lines.push(formatMessage(msg));
  }

  return lines.join("\n");
}

/**
 * Format a timestamp as relative time.
 */
function formatRelativeTime(timestampMs: number): string {
  const now = Date.now();
  const diffMs = now - timestampMs;
  const diffMin = Math.floor(diffMs / 60_000);
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

/**
 * Build the prompt section for thread context.
 * Returns empty string if no thread context available.
 */
export function buildThreadContextSection(injections: ThreadContextInjection[]): string {
  if (injections.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const injection of injections) {
    parts.push(injection.formattedContext);
  }

  return parts.join("\n\n");
}
