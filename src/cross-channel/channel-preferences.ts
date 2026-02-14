/**
 * Channel Preference Learning (Hephie Phase 3.4)
 *
 * Learns per-user channel preferences from message history.
 * Tracks patterns like "uses Telegram for quick questions,
 * Slack for work discussions" and builds weighted preferences.
 *
 * Preferences update over time with exponential decay —
 * recent behavior counts more than old behavior.
 */

import type {
  ChannelPreference,
  MessageType,
  UserChannelPreferences,
} from "./channel-selector-types.js";
import type { ChannelType } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────

/** A single message observation for preference learning. */
export interface MessageObservation {
  /** Channel the message was sent on. */
  channelType: ChannelType;

  /** Message type (if detected). */
  messageType?: MessageType;

  /** When the message was sent. */
  timestamp: number;

  /** Hour of day (0-23) when sent. */
  hourOfDay?: number;
}

/** Configuration for preference learning. */
export interface PreferenceLearnerConfig {
  /** Decay factor for older messages (0-1). Lower = faster decay. Default: 0.95. */
  decayFactor: number;

  /** Maximum age of observations to consider (ms). Default: 30 days. */
  maxObservationAgeMs: number;

  /** Minimum number of observations to form preferences. Default: 3. */
  minObservations: number;

  /** Window size for rolling computation. Default: 100 messages. */
  windowSize: number;
}

/** Default learner configuration. */
export const DEFAULT_LEARNER_CONFIG: PreferenceLearnerConfig = {
  decayFactor: 0.95,
  maxObservationAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  minObservations: 3,
  windowSize: 100,
};

// ── Implementation ──────────────────────────────────────────────────────

/**
 * Learns and maintains channel preferences per user.
 */
export class ChannelPreferenceLearner {
  /** userId → observations (most recent first) */
  private observations: Map<string, MessageObservation[]> = new Map();
  /** userId → computed preferences (cached) */
  private cache: Map<string, UserChannelPreferences> = new Map();
  private config: PreferenceLearnerConfig;

  constructor(config?: Partial<PreferenceLearnerConfig>) {
    this.config = { ...DEFAULT_LEARNER_CONFIG, ...config };
  }

  /**
   * Record a message observation for a user.
   */
  recordObservation(params: {
    userId: string;
    channelType: ChannelType;
    messageType?: MessageType;
    timestamp?: number;
  }): void {
    const userId = params.userId.toLowerCase().trim();
    const ts = params.timestamp ?? Date.now();
    const hour = new Date(ts).getHours();

    const obs: MessageObservation = {
      channelType: params.channelType,
      messageType: params.messageType,
      timestamp: ts,
      hourOfDay: hour,
    };

    if (!this.observations.has(userId)) {
      this.observations.set(userId, []);
    }

    const userObs = this.observations.get(userId)!;
    userObs.push(obs);

    // Keep within window size
    if (userObs.length > this.config.windowSize) {
      userObs.splice(0, userObs.length - this.config.windowSize);
    }

    // Invalidate cache
    this.cache.delete(userId);
  }

  /**
   * Get computed channel preferences for a user.
   * Returns cached result if observations haven't changed.
   */
  getPreferences(userId: string, now?: number): UserChannelPreferences | null {
    const normalizedId = userId.toLowerCase().trim();

    // Check cache
    const cached = this.cache.get(normalizedId);
    if (cached) {
      return cached;
    }

    const userObs = this.observations.get(normalizedId);
    if (!userObs || userObs.length < this.config.minObservations) {
      return null;
    }

    const currentTime = now ?? Date.now();
    const preferences = this.computePreferences(normalizedId, userObs, currentTime);
    this.cache.set(normalizedId, preferences);
    return preferences;
  }

  /**
   * Get the preference weight for a specific channel for a user (0-1).
   */
  getChannelWeight(userId: string, channelType: ChannelType, now?: number): number {
    const prefs = this.getPreferences(userId, now);
    if (!prefs) {
      return 0;
    }

    const pref = prefs.preferences.find((p) => p.channelType === channelType);
    return pref?.weight ?? 0;
  }

  /**
   * Get the top preferred channel for a user.
   */
  getTopChannel(userId: string, now?: number): ChannelPreference | null {
    const prefs = this.getPreferences(userId, now);
    if (!prefs || prefs.preferences.length === 0) {
      return null;
    }
    return prefs.preferences[0];
  }

  /**
   * Get observations for a user (for inspection/debugging).
   */
  getObservations(userId: string): MessageObservation[] {
    const normalizedId = userId.toLowerCase().trim();
    const obs = this.observations.get(normalizedId);
    return obs ? [...obs] : [];
  }

  /**
   * Get the number of tracked users.
   */
  getTrackedUserCount(): number {
    return this.observations.size;
  }

  /**
   * Clear all data.
   */
  clear(): void {
    this.observations.clear();
    this.cache.clear();
  }

  /**
   * Clear data for a specific user.
   */
  clearUser(userId: string): boolean {
    const normalizedId = userId.toLowerCase().trim();
    this.cache.delete(normalizedId);
    return this.observations.delete(normalizedId);
  }

  /**
   * Serialize for persistence.
   */
  toJSON(): Record<string, MessageObservation[]> {
    const result: Record<string, MessageObservation[]> = {};
    for (const [userId, obs] of this.observations) {
      result[userId] = [...obs];
    }
    return result;
  }

  /**
   * Load from serialized form.
   */
  static fromJSON(
    data: Record<string, MessageObservation[]>,
    config?: Partial<PreferenceLearnerConfig>,
  ): ChannelPreferenceLearner {
    const learner = new ChannelPreferenceLearner(config);
    for (const [userId, obs] of Object.entries(data)) {
      if (Array.isArray(obs)) {
        const validObs = obs.filter(isMessageObservation);
        if (validObs.length > 0) {
          learner.observations.set(userId.toLowerCase().trim(), validObs);
        }
      }
    }
    return learner;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private computePreferences(
    userId: string,
    observations: MessageObservation[],
    now: number,
  ): UserChannelPreferences {
    // Filter out observations that are too old
    const maxAge = this.config.maxObservationAgeMs;
    const relevant = observations.filter((o) => now - o.timestamp <= maxAge);

    if (relevant.length === 0) {
      return {
        userId,
        preferences: [],
        computedAt: now,
        totalMessages: 0,
      };
    }

    // Group by channel and compute weighted scores
    const channelData: Map<
      ChannelType,
      {
        totalWeight: number;
        count: number;
        messageTypes: Map<MessageType, number>;
        hours: Map<number, number>;
      }
    > = new Map();

    for (const obs of relevant) {
      if (!channelData.has(obs.channelType)) {
        channelData.set(obs.channelType, {
          totalWeight: 0,
          count: 0,
          messageTypes: new Map(),
          hours: new Map(),
        });
      }

      const data = channelData.get(obs.channelType)!;

      // Apply time decay: more recent observations get higher weight
      const ageMs = now - obs.timestamp;
      const ageInDays = ageMs / (24 * 60 * 60 * 1000);
      const weight = Math.pow(this.config.decayFactor, ageInDays);

      data.totalWeight += weight;
      data.count += 1;

      if (obs.messageType) {
        data.messageTypes.set(obs.messageType, (data.messageTypes.get(obs.messageType) ?? 0) + 1);
      }

      if (obs.hourOfDay !== undefined) {
        data.hours.set(obs.hourOfDay, (data.hours.get(obs.hourOfDay) ?? 0) + 1);
      }
    }

    // Compute total weight for normalization
    let totalWeight = 0;
    for (const data of channelData.values()) {
      totalWeight += data.totalWeight;
    }

    // Build preferences
    const preferences: ChannelPreference[] = [];
    for (const [channelType, data] of channelData) {
      const normalizedWeight = totalWeight > 0 ? data.totalWeight / totalWeight : 0;

      // Top 3 message types for this channel
      const sortedTypes = Array.from(data.messageTypes.entries())
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([type]) => type);

      // Hours with most activity
      const sortedHours = Array.from(data.hours.entries())
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([hour]) => hour);

      preferences.push({
        channelType,
        weight: normalizedWeight,
        sampleSize: data.count,
        commonMessageTypes: sortedTypes,
        activeHours: sortedHours,
      });
    }

    // Sort by weight (highest first)
    preferences.sort((a, b) => b.weight - a.weight);

    return {
      userId,
      preferences,
      computedAt: now,
      totalMessages: relevant.length,
    };
  }
}

/**
 * Type guard for MessageObservation.
 */
function isMessageObservation(value: unknown): value is MessageObservation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.channelType === "string" && typeof obj.timestamp === "number";
}
