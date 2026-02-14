/**
 * Hephie Session Hooks
 *
 * Wires the memory system into the session lifecycle:
 *
 * - **onSessionEnd**: Extract key facts from the conversation and store
 *   as Short-Term chunks.
 * - **onCompaction**: Before compacting, extract and preserve important
 *   context to Short-Term memory.
 * - **onMessage**: After each user message, run context assembly and
 *   produce the injection block for the system prompt.
 */

import type { QuerySignals, AssembledContext } from "./context-injector.js";
import type { MemorySystem, RememberOpts } from "./system.js";

// ── Types ─────────────────────────────────────────────────────────────────

/** A single message from a conversation. */
export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
}

/** Extracted fact from conversation analysis. */
export interface ExtractedFact {
  /** The fact content. */
  content: string;
  /** Semantic category. */
  category?: string;
  /** Related person. */
  person?: string;
  /** Searchable tags. */
  tags?: string[];
  /** How confident we are this is a real fact (0-1). */
  confidence?: number;
  /** Whether this is explicitly important (user said "remember this"). */
  important?: boolean;
}

/** Options for fact extraction. */
export interface ExtractionOpts {
  /** The channel this conversation is from. */
  channel?: string;
  /** The session ID. */
  sessionId?: string;
  /** The person we're talking to. */
  person?: string;
  /** Source label. */
  source?: string;
}

/** Result of processing a session or compaction. */
export interface HookResult {
  /** Number of facts extracted and stored. */
  factsStored: number;
  /** The chunk IDs that were created. */
  chunkIds: string[];
  /** Any errors that occurred (non-fatal). */
  errors: string[];
}

// ── Heuristic Fact Extraction ─────────────────────────────────────────────

/**
 * Simple heuristic patterns for detecting important facts in conversation.
 * These are NOT LLM-based — they're fast pattern matches designed to catch
 * the most common fact patterns until LLM-based extraction is available.
 */
const FACT_PATTERNS: Array<{
  pattern: RegExp;
  category: string;
  confidenceBoost: number;
}> = [
  // Explicit memory requests
  { pattern: /remember\s+(?:that|this|:)\s*/i, category: "fact", confidenceBoost: 0.3 },
  { pattern: /don'?t\s+forget\s*/i, category: "fact", confidenceBoost: 0.3 },
  { pattern: /keep\s+in\s+mind\s*/i, category: "fact", confidenceBoost: 0.2 },
  { pattern: /important\s*:\s*/i, category: "fact", confidenceBoost: 0.25 },
  { pattern: /note\s*:\s*/i, category: "fact", confidenceBoost: 0.15 },

  // Decisions
  { pattern: /(?:we|I)\s+decided\s+(?:to|that)\s*/i, category: "decision", confidenceBoost: 0.2 },
  { pattern: /let'?s\s+go\s+with\s*/i, category: "decision", confidenceBoost: 0.15 },
  { pattern: /the\s+plan\s+is\s*/i, category: "decision", confidenceBoost: 0.15 },

  // Preferences
  { pattern: /(?:I|we)\s+prefer\s*/i, category: "preference", confidenceBoost: 0.2 },
  {
    pattern: /(?:I|we)\s+(?:always|never)\s+(?:use|want|like)\s*/i,
    category: "preference",
    confidenceBoost: 0.15,
  },

  // Lessons learned
  { pattern: /(?:I|we)\s+learned\s+(?:that|:)\s*/i, category: "lesson", confidenceBoost: 0.2 },
  { pattern: /lesson\s*:\s*/i, category: "lesson", confidenceBoost: 0.2 },
  { pattern: /never\s+again\s*/i, category: "lesson", confidenceBoost: 0.15 },

  // Person information
  {
    pattern: /(?:his|her|their)\s+(?:name|email|phone|role|title)\s+is\s*/i,
    category: "person",
    confidenceBoost: 0.2,
  },
  {
    pattern: /(?:he|she|they)\s+(?:works?|lives?|is)\s+(?:at|in|a)\s*/i,
    category: "person",
    confidenceBoost: 0.1,
  },

  // Events
  {
    pattern: /(?:today|yesterday|tomorrow)\s+(?:we|I)\s*/i,
    category: "event",
    confidenceBoost: 0.1,
  },
  {
    pattern: /(?:just|recently)\s+(?:set up|configured|deployed|fixed|broke|updated)\s*/i,
    category: "event",
    confidenceBoost: 0.1,
  },
];

/**
 * Extract facts from conversation messages using heuristic patterns.
 *
 * This is a fast, no-LLM extraction. It catches explicit memory requests
 * and common patterns. For deeper extraction, an LLM-based approach
 * should be layered on top.
 */
function extractFactsFromMessages(
  messages: ConversationMessage[],
  opts: ExtractionOpts = {},
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    // Only extract from user and assistant messages
    if (msg.role === "system") {
      continue;
    }

    const content = msg.content;

    for (const { pattern, category, confidenceBoost } of FACT_PATTERNS) {
      const match = pattern.exec(content);
      if (!match) {
        continue;
      }

      // Extract the rest of the sentence after the pattern match
      const afterMatch = content.slice(match.index + match[0].length);
      const sentence = extractSentence(afterMatch);
      if (!sentence || sentence.length < 10) {
        continue;
      }

      // Deduplicate
      const key = sentence.toLowerCase().trim();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const isExplicit = /remember|don'?t forget|keep in mind|important/i.test(match[0]);

      facts.push({
        content: sentence,
        category,
        person: opts.person,
        tags: [category],
        confidence: Math.min(0.5 + confidenceBoost + (isExplicit ? 0.2 : 0), 1.0),
        important: isExplicit,
      });
    }
  }

  return facts;
}

/**
 * Extract a single sentence from text (up to the first period, newline, or 200 chars).
 */
function extractSentence(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) {
    return "";
  }

  // Find end of sentence
  const periodIdx = cleaned.indexOf(".");
  const newlineIdx = cleaned.indexOf("\n");
  const maxLen = 200;

  let endIdx = maxLen;
  if (periodIdx > 0 && periodIdx < endIdx) {
    endIdx = periodIdx + 1;
  }
  if (newlineIdx > 0 && newlineIdx < endIdx) {
    endIdx = newlineIdx;
  }

  return cleaned.slice(0, endIdx).trim();
}

/**
 * Extract a summary of the conversation (for compaction preservation).
 * Takes the key decision points and topics discussed.
 */
function extractConversationSummary(messages: ConversationMessage[]): string {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    return "";
  }

  // Take up to 5 most recent user messages as topic indicators
  const recentTopics = userMessages.slice(-5).map((m) => {
    const firstLine = m.content.split("\n")[0].trim();
    return firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
  });

  return `Conversation topics: ${recentTopics.join("; ")}`;
}

// ── SessionHooks ──────────────────────────────────────────────────────────

export class SessionHooks {
  private readonly memory: MemorySystem;

  constructor(memory: MemorySystem) {
    this.memory = memory;
  }

  /**
   * Called when a session ends.
   * Extracts key facts from the conversation and stores them as Short-Term chunks.
   */
  async onSessionEnd(
    messages: ConversationMessage[],
    opts: ExtractionOpts = {},
  ): Promise<HookResult> {
    const facts = extractFactsFromMessages(messages, opts);
    return this.storeFacts(facts, opts);
  }

  /**
   * Called before conversation compaction.
   * Extracts important context and preserves it in Short-Term memory
   * so it survives the compaction.
   */
  async onCompaction(
    messages: ConversationMessage[],
    opts: ExtractionOpts = {},
  ): Promise<HookResult> {
    const result: HookResult = { factsStored: 0, chunkIds: [], errors: [] };

    // 1. Extract explicit facts
    const facts = extractFactsFromMessages(messages, opts);

    // 2. Store a conversation summary
    const summary = extractConversationSummary(messages);
    if (summary) {
      facts.push({
        content: summary,
        category: "event",
        person: opts.person,
        tags: ["session-summary", "compaction"],
        confidence: 0.6,
      });
    }

    // 3. Store all facts
    const storeResult = await this.storeFacts(facts, opts);
    result.factsStored = storeResult.factsStored;
    result.chunkIds = storeResult.chunkIds;
    result.errors = storeResult.errors;

    return result;
  }

  /**
   * Called after each user message.
   * Runs context assembly and returns the injection block for the system prompt.
   */
  async onMessage(message: string, opts: ExtractionOpts = {}): Promise<AssembledContext> {
    const signals: QuerySignals = {
      currentMessage: message,
      currentPerson: opts.person,
      channel: opts.channel,
      sessionId: opts.sessionId,
    };

    return this.memory.assembleContext(signals);
  }

  /**
   * Store extracted facts as Short-Term memory chunks.
   */
  private async storeFacts(facts: ExtractedFact[], opts: ExtractionOpts = {}): Promise<HookResult> {
    const result: HookResult = { factsStored: 0, chunkIds: [], errors: [] };

    for (const fact of facts) {
      try {
        const rememberOpts: RememberOpts = {
          tier: fact.important ? "long_term" : "short_term",
          category: fact.category,
          person: fact.person ?? opts.person,
          tags: fact.tags,
          source: opts.source ?? "session",
          confidence: fact.confidence ?? 0.7,
        };

        const id = await this.memory.remember(fact.content, rememberOpts);
        result.chunkIds.push(id);
        result.factsStored++;
      } catch (err) {
        result.errors.push(
          `Failed to store fact: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }
}

// ── Exports for testing ───────────────────────────────────────────────────

export {
  extractFactsFromMessages as _extractFactsFromMessages,
  extractConversationSummary as _extractConversationSummary,
};
