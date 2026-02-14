/**
 * Channel Affinity Mapping (Hephie Phase 3.4)
 *
 * Maps message content types to preferred channels.
 * Configurable rules that determine which channels are best
 * suited for different kinds of content.
 *
 * Examples:
 *   - Code snippets → Slack (formatting support)
 *   - File sharing → Telegram (no compression)
 *   - Urgent messages → most recently active channel
 */

import type { AffinityConfig, AffinityRule, MessageType } from "./channel-selector-types.js";
import type { ChannelType } from "./types.js";
import { DEFAULT_AFFINITY_CONFIG, DEFAULT_AFFINITY_RULES } from "./channel-selector-types.js";

/**
 * Manages message type → channel affinity rules.
 */
export class ChannelAffinityMapper {
  private rules: Map<MessageType, AffinityRule> = new Map();
  private config: AffinityConfig;

  constructor(config?: Partial<AffinityConfig>) {
    this.config = { ...DEFAULT_AFFINITY_CONFIG, ...config };

    // Load initial rules
    const rules = config?.rules ?? DEFAULT_AFFINITY_RULES;
    for (const rule of rules) {
      this.rules.set(rule.messageType, { ...rule });
    }
  }

  /**
   * Add or replace an affinity rule.
   */
  setRule(rule: AffinityRule): void {
    this.rules.set(rule.messageType, { ...rule });
  }

  /**
   * Remove an affinity rule.
   */
  removeRule(messageType: MessageType): boolean {
    return this.rules.delete(messageType);
  }

  /**
   * Get the affinity rule for a message type.
   */
  getRule(messageType: MessageType): AffinityRule | undefined {
    const rule = this.rules.get(messageType);
    return rule ? { ...rule } : undefined;
  }

  /**
   * Get all rules.
   */
  getAllRules(): AffinityRule[] {
    return Array.from(this.rules.values()).map((r) => ({ ...r }));
  }

  /**
   * Compute an affinity score for a channel given a message type (0-1).
   *
   * Scoring:
   *   - Channel is in preferredChannels: score based on position (first=1.0, decaying)
   *   - Channel is in avoidChannels: 0.0
   *   - Channel is neither: 0.5 (neutral)
   *   - No rule for messageType: 0.5 (no opinion)
   *   - preferredChannels is empty: 0.5 (no preference — use other signals)
   */
  computeAffinityScore(channelType: ChannelType, messageType?: MessageType): number {
    if (!messageType) {
      return 0.5; // No message type → no affinity opinion
    }

    const rule = this.rules.get(messageType);
    if (!rule) {
      return 0.5; // No rule → neutral
    }

    // Check avoidChannels first
    if (rule.avoidChannels?.includes(channelType)) {
      return 0.0;
    }

    // Check preferredChannels
    if (rule.preferredChannels.length === 0) {
      return 0.5; // Empty preference → use other signals (e.g., most recent)
    }

    const index = rule.preferredChannels.indexOf(channelType);
    if (index === -1) {
      return 0.3; // Not preferred, but not avoided either
    }

    // Score based on position: first=1.0, second=0.85, third=0.7, etc.
    return Math.max(0.4, 1.0 - index * 0.15);
  }

  /**
   * Get the best channels for a message type, ranked by affinity.
   */
  getBestChannels(messageType: MessageType, availableChannels: ChannelType[]): ChannelType[] {
    const rule = this.rules.get(messageType);
    if (!rule) {
      return [...availableChannels]; // No rule → all channels equal
    }

    // Filter out avoided channels
    const eligible = availableChannels.filter((ch) => !rule.avoidChannels?.includes(ch));

    // Sort by affinity score (highest first)
    return eligible.toSorted((a, b) => {
      const scoreA = this.computeAffinityScore(a, messageType);
      const scoreB = this.computeAffinityScore(b, messageType);
      return scoreB - scoreA;
    });
  }

  /**
   * Get the reason string for a channel's affinity with a message type.
   */
  getAffinityReason(channelType: ChannelType, messageType?: MessageType): string | null {
    if (!messageType) {
      return null;
    }

    const rule = this.rules.get(messageType);
    if (!rule) {
      return null;
    }

    if (rule.avoidChannels?.includes(channelType)) {
      return `${channelType} is avoided for ${messageType}: ${rule.reason}`;
    }

    const index = rule.preferredChannels.indexOf(channelType);
    if (index === 0) {
      return `${channelType} is top choice for ${messageType}: ${rule.reason}`;
    }
    if (index > 0) {
      return `${channelType} is preferred (#${index + 1}) for ${messageType}: ${rule.reason}`;
    }

    return null;
  }

  /**
   * Check if a channel should be avoided for a message type.
   */
  shouldAvoid(channelType: ChannelType, messageType: MessageType): boolean {
    const rule = this.rules.get(messageType);
    return rule?.avoidChannels?.includes(channelType) ?? false;
  }

  /**
   * Get the affinity weight from config.
   */
  getAffinityWeight(): number {
    return this.config.affinityWeight;
  }

  /**
   * Whether affinity rules override user preferences.
   */
  doesOverridePreferences(): boolean {
    return this.config.overridePreferences;
  }

  /**
   * Update the configuration.
   */
  setConfig(config: Partial<AffinityConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Number of rules.
   */
  get ruleCount(): number {
    return this.rules.size;
  }

  /**
   * Clear all rules.
   */
  clear(): void {
    this.rules.clear();
  }
}
