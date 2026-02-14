/**
 * Smart Channel Selector (Hephie Phase 3.4)
 *
 * The main API: selectBestChannel(userId, messageType, urgency)
 *
 * Combines four signals to rank channels:
 *   1. User preference (learned from history)
 *   2. User availability (per-channel last-seen)
 *   3. Message type affinity (content → channel mapping)
 *   4. Recency (current reply channel bonus)
 *
 * Produces a ranked list of ChannelRecommendation with reasoning.
 * Integrates with ReplyRouter (can override default reply channel)
 * and CrossChannelSender (uses registered channels + fallback chain).
 */

import type { ChannelAffinityMapper } from "./channel-affinity.js";
import type { ChannelPreferenceLearner } from "./channel-preferences.js";
import type {
  ChannelRecommendation,
  ChannelSelectionRequest,
  ChannelSelectionResult,
  FallbackChain,
  SmartChannelSelectorConfig,
  UrgencyLevel,
} from "./channel-selector-types.js";
import type { ReplyRoute } from "./reply-router.js";
import type { ChannelType } from "./types.js";
import type { UserAvailabilityTracker } from "./user-availability.js";
import { DEFAULT_SELECTOR_CONFIG } from "./channel-selector-types.js";

/**
 * Smart channel selector that combines multiple signals to pick
 * the best channel for outbound messages.
 */
export class SmartChannelSelector {
  private config: SmartChannelSelectorConfig;
  private availability: UserAvailabilityTracker;
  private preferences: ChannelPreferenceLearner;
  private affinity: ChannelAffinityMapper;

  /** userId → fallback chain */
  private fallbackChains: Map<string, FallbackChain> = new Map();

  /** Set of all channels known to be available for sending. */
  private registeredChannels: Set<ChannelType> = new Set();

  constructor(params: {
    availability: UserAvailabilityTracker;
    preferences: ChannelPreferenceLearner;
    affinity: ChannelAffinityMapper;
    config?: Partial<SmartChannelSelectorConfig>;
  }) {
    this.availability = params.availability;
    this.preferences = params.preferences;
    this.affinity = params.affinity;
    this.config = { ...DEFAULT_SELECTOR_CONFIG, ...params.config };

    // Merge weights if partially provided
    if (params.config?.weights) {
      this.config.weights = { ...DEFAULT_SELECTOR_CONFIG.weights, ...params.config.weights };
    }
  }

  /**
   * Register a channel as available for sending.
   */
  registerChannel(channelType: ChannelType): void {
    this.registeredChannels.add(channelType);
  }

  /**
   * Register multiple channels.
   */
  registerChannels(channels: ChannelType[]): void {
    for (const ch of channels) {
      this.registeredChannels.add(ch);
    }
  }

  /**
   * Set a fallback chain for a user.
   */
  setFallbackChain(chain: FallbackChain): void {
    this.fallbackChains.set(chain.userId.toLowerCase().trim(), { ...chain });
  }

  /**
   * Get the fallback chain for a user.
   */
  getFallbackChain(userId: string): FallbackChain | undefined {
    const chain = this.fallbackChains.get(userId.toLowerCase().trim());
    return chain ? { ...chain } : undefined;
  }

  /**
   * Remove a fallback chain.
   */
  removeFallbackChain(userId: string): boolean {
    return this.fallbackChains.delete(userId.toLowerCase().trim());
  }

  /**
   * THE MAIN API: Select the best channel for an outbound message.
   *
   * Returns a ranked list of channels with scores and reasoning.
   */
  selectBestChannel(request: ChannelSelectionRequest): ChannelSelectionResult {
    const now = request.now ?? Date.now();
    const userId = request.userId.toLowerCase().trim();

    // If force channel is specified, short-circuit
    if (request.forceChannel) {
      return this.buildForcedResult(request.forceChannel, userId);
    }

    // Determine candidate channels
    const candidates = this.getCandidateChannels(userId);
    if (candidates.length === 0) {
      return {
        recommendations: [],
        best: null,
        overridesReplyChannel: false,
        reasoning: "No channels available for this user",
      };
    }

    // Score each candidate channel
    const recommendations: ChannelRecommendation[] = [];

    for (const channelType of candidates) {
      const { score, reasons } = this.scoreChannel({
        userId,
        channelType,
        messageType: request.messageType,
        urgency: request.urgency,
        currentReplyChannel: request.currentReplyChannel,
        now,
      });

      // Get destination info from availability tracker
      const activity = this.availability.getActivity(userId, channelType);

      // Check fallback chain for destination overrides
      const chain = this.fallbackChains.get(userId);
      const chainDest = chain?.destinations?.[channelType];
      const chainAcct = chain?.accountIds?.[channelType];

      recommendations.push({
        channel: channelType,
        score,
        destination: chainDest ?? activity?.destination,
        accountId: chainAcct ?? activity?.accountId,
        reasons,
      });
    }

    // Sort by score (highest first)
    recommendations.sort((a, b) => b.score - a.score);

    // Apply fallback chain ordering (if no strong signal, respect user's fallback order)
    const reordered = this.applyFallbackOrdering(userId, recommendations);

    // Determine if we should override the reply channel
    const best = reordered[0] ?? null;
    const overridesReplyChannel = this.shouldOverrideReplyChannel(
      best,
      request.currentReplyChannel,
    );

    // Build reasoning summary
    const reasoning = this.buildReasoning(reordered, request, overridesReplyChannel);

    return {
      recommendations: reordered,
      best,
      overridesReplyChannel,
      reasoning,
    };
  }

  /**
   * Get the next channel in the fallback chain after the given channel.
   * Useful when primary channel fails and we need to try the next one.
   */
  getNextFallback(userId: string, failedChannel: ChannelType): ChannelRecommendation | null {
    const chain = this.fallbackChains.get(userId.toLowerCase().trim());
    if (!chain) {
      return null;
    }

    const idx = chain.channelOrder.indexOf(failedChannel);
    if (idx === -1 || idx >= chain.channelOrder.length - 1) {
      return null;
    }

    const nextChannel = chain.channelOrder[idx + 1];
    const activity = this.availability.getActivity(userId, nextChannel);

    return {
      channel: nextChannel,
      score: 0.5, // Fallback score
      destination: chain.destinations?.[nextChannel] ?? activity?.destination,
      accountId: chain.accountIds?.[nextChannel] ?? activity?.accountId,
      reasons: [`Fallback from ${failedChannel} (position ${idx + 2} in chain)`],
    };
  }

  /**
   * Get the underlying components (for testing/inspection).
   */
  getComponents() {
    return {
      availability: this.availability,
      preferences: this.preferences,
      affinity: this.affinity,
    };
  }

  /**
   * Get the current config.
   */
  getConfig(): SmartChannelSelectorConfig {
    return { ...this.config };
  }

  /**
   * Update configuration.
   */
  setConfig(config: Partial<SmartChannelSelectorConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.weights) {
      this.config.weights = { ...this.config.weights, ...config.weights };
    }
  }

  /**
   * Get registered channels.
   */
  getRegisteredChannels(): ChannelType[] {
    return Array.from(this.registeredChannels);
  }

  // ── Internal Scoring ──────────────────────────────────────────────────

  private scoreChannel(params: {
    userId: string;
    channelType: ChannelType;
    messageType?: string;
    urgency?: UrgencyLevel;
    currentReplyChannel?: ChannelType;
    now: number;
  }): { score: number; reasons: string[] } {
    const { userId, channelType, messageType, urgency, currentReplyChannel, now } = params;
    const weights = this.config.weights;
    const reasons: string[] = [];

    // 1. Preference score
    const prefWeight = this.preferences.getChannelWeight(userId, channelType, now);
    const prefScore = prefWeight;
    if (prefScore > 0.5) {
      reasons.push(`User prefers ${channelType} (weight: ${prefScore.toFixed(2)})`);
    }

    // 2. Availability score
    const availScore = this.availability.computeAvailabilityScore(userId, channelType, now);
    if (availScore >= 0.7) {
      const avail = this.availability.getAvailability(userId, channelType, now);
      reasons.push(`User is ${avail.status} on ${channelType}`);
    }

    // 3. Affinity score
    const affinityScore = this.affinity.computeAffinityScore(channelType, messageType);
    const affinityReason = this.affinity.getAffinityReason(channelType, messageType);
    if (affinityReason) {
      reasons.push(affinityReason);
    }

    // 4. Recency score (bonus for current reply channel)
    let recencyScore = 0.5; // neutral
    if (currentReplyChannel === channelType) {
      recencyScore = 1.0;
      reasons.push(`Current reply channel`);
    }

    // 5. Urgency modifier
    let urgencyMultiplier = 1.0;
    if (urgency === "critical" || urgency === "high") {
      // For urgent messages, heavily weight availability
      urgencyMultiplier = 1.0;
      if (availScore >= 0.7) {
        reasons.push(`Urgent: user is reachable on ${channelType}`);
      }
    }

    // Compute weighted score
    let score =
      prefScore * weights.preference +
      availScore * weights.availability +
      affinityScore * weights.affinity +
      recencyScore * weights.recency;

    // Apply urgency: boost availability weight for urgent messages
    if (urgency === "critical") {
      score = availScore * 0.5 + score * 0.5;
    } else if (urgency === "high") {
      score = availScore * 0.3 + score * 0.7;
    }

    score *= urgencyMultiplier;

    // Clamp to [0, 1]
    score = Math.max(0, Math.min(1, score));

    return { score, reasons };
  }

  private getCandidateChannels(userId: string): ChannelType[] {
    // Start with registered channels
    const candidates = new Set<ChannelType>(this.registeredChannels);

    // Add channels from user's availability data
    const userAvail = this.availability.getAllAvailability(userId);
    for (const avail of userAvail) {
      candidates.add(avail.channelType);
    }

    // Add channels from user's fallback chain
    const chain = this.fallbackChains.get(userId);
    if (chain) {
      for (const ch of chain.channelOrder) {
        candidates.add(ch);
      }
    }

    // Add channels from user's preference data
    const prefs = this.preferences.getPreferences(userId);
    if (prefs) {
      for (const pref of prefs.preferences) {
        candidates.add(pref.channelType);
      }
    }

    return Array.from(candidates);
  }

  private buildForcedResult(channel: ChannelType, userId: string): ChannelSelectionResult {
    const activity = this.availability.getActivity(userId, channel);
    const chain = this.fallbackChains.get(userId);

    return {
      recommendations: [
        {
          channel,
          score: 1.0,
          destination: chain?.destinations?.[channel] ?? activity?.destination,
          accountId: chain?.accountIds?.[channel] ?? activity?.accountId,
          reasons: ["Forced channel override"],
        },
      ],
      best: {
        channel,
        score: 1.0,
        destination: chain?.destinations?.[channel] ?? activity?.destination,
        accountId: chain?.accountIds?.[channel] ?? activity?.accountId,
        reasons: ["Forced channel override"],
      },
      overridesReplyChannel: true,
      reasoning: `Channel forced to ${channel}`,
    };
  }

  private shouldOverrideReplyChannel(
    best: ChannelRecommendation | null,
    currentReplyChannel?: ChannelType,
  ): boolean {
    if (!this.config.enableOverride) {
      return false;
    }
    if (!best || !currentReplyChannel) {
      return false;
    }
    if (best.channel === currentReplyChannel) {
      return false;
    }

    // Find the score for the current reply channel in recommendations
    // If best channel score is significantly higher, override
    return best.score >= this.config.overrideThreshold;
  }

  private applyFallbackOrdering(
    userId: string,
    recommendations: ChannelRecommendation[],
  ): ChannelRecommendation[] {
    const chain = this.fallbackChains.get(userId);
    if (!chain) {
      return recommendations;
    }

    // If scores are very close (within 0.05), use fallback chain ordering
    const sorted = [...recommendations];
    sorted.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.05) {
        return scoreDiff; // Significant difference → use score
      }

      // Scores are close → use fallback chain position
      const posA = chain.channelOrder.indexOf(a.channel);
      const posB = chain.channelOrder.indexOf(b.channel);

      // Channels not in fallback chain go to the end
      const effPosA = posA === -1 ? 999 : posA;
      const effPosB = posB === -1 ? 999 : posB;
      return effPosA - effPosB;
    });

    return sorted;
  }

  private buildReasoning(
    recommendations: ChannelRecommendation[],
    request: ChannelSelectionRequest,
    overrides: boolean,
  ): string {
    const parts: string[] = [];

    if (recommendations.length === 0) {
      return "No channels available";
    }

    const best = recommendations[0];
    parts.push(`Best channel: ${best.channel} (score: ${best.score.toFixed(2)})`);

    if (best.reasons.length > 0) {
      parts.push(`Reasons: ${best.reasons.join("; ")}`);
    }

    if (request.messageType) {
      parts.push(`Message type: ${request.messageType}`);
    }

    if (request.urgency && request.urgency !== "normal") {
      parts.push(`Urgency: ${request.urgency}`);
    }

    if (overrides && request.currentReplyChannel) {
      parts.push(`Overrides default reply channel (${request.currentReplyChannel})`);
    }

    if (recommendations.length > 1) {
      const fallbacks = recommendations
        .slice(1, 4)
        .map((r) => `${r.channel} (${r.score.toFixed(2)})`)
        .join(", ");
      parts.push(`Fallbacks: ${fallbacks}`);
    }

    return parts.join(". ");
  }
}
