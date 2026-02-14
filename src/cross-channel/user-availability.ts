/**
 * User Availability Tracker (Hephie Phase 3.4)
 *
 * Tracks per-user, per-channel activity timestamps to determine
 * where a user is most likely to see a message right now.
 *
 * "Active" = user SENT a message (not just received one).
 */

import type {
  AvailabilityStatus,
  ChannelAvailability,
  StalenessThresholds,
  UserChannelActivity,
} from "./channel-selector-types.js";
import type { ChannelType } from "./types.js";
import { DEFAULT_STALENESS_THRESHOLDS } from "./channel-selector-types.js";

/**
 * In-memory tracker for user availability across channels.
 */
export class UserAvailabilityTracker {
  /** userId → channelType → activity */
  private activity: Map<string, Map<ChannelType, UserChannelActivity>> = new Map();
  private thresholds: StalenessThresholds;

  constructor(thresholds?: Partial<StalenessThresholds>) {
    this.thresholds = { ...DEFAULT_STALENESS_THRESHOLDS, ...thresholds };
  }

  /**
   * Record that a user sent a message on a channel.
   */
  recordActivity(params: {
    userId: string;
    channelType: ChannelType;
    timestamp?: number;
    destination?: string;
    accountId?: string;
  }): UserChannelActivity {
    const userId = params.userId.toLowerCase().trim();
    const ts = params.timestamp ?? Date.now();

    if (!this.activity.has(userId)) {
      this.activity.set(userId, new Map());
    }
    const userMap = this.activity.get(userId)!;

    const existing = userMap.get(params.channelType);
    if (existing) {
      existing.lastActiveAt = Math.max(existing.lastActiveAt, ts);
      existing.messageCount += 1;
      if (params.destination) {
        existing.destination = params.destination;
      }
      if (params.accountId) {
        existing.accountId = params.accountId;
      }
      return { ...existing };
    }

    const entry: UserChannelActivity = {
      channelType: params.channelType,
      lastActiveAt: ts,
      messageCount: 1,
      destination: params.destination,
      accountId: params.accountId,
    };
    userMap.set(params.channelType, entry);
    return { ...entry };
  }

  /**
   * Get the availability status for a user on a specific channel.
   */
  getAvailability(userId: string, channelType: ChannelType, now?: number): ChannelAvailability {
    const currentTime = now ?? Date.now();
    const normalizedId = userId.toLowerCase().trim();
    const userMap = this.activity.get(normalizedId);

    if (!userMap) {
      return {
        channelType,
        status: "unknown",
        lastActiveAt: null,
        ageSinceActiveMs: null,
      };
    }

    const entry = userMap.get(channelType);
    if (!entry) {
      return {
        channelType,
        status: "unknown",
        lastActiveAt: null,
        ageSinceActiveMs: null,
      };
    }

    const age = currentTime - entry.lastActiveAt;
    const status = this.classifyAge(age);

    return {
      channelType,
      status,
      lastActiveAt: entry.lastActiveAt,
      ageSinceActiveMs: age,
      destination: entry.destination,
      accountId: entry.accountId,
    };
  }

  /**
   * Get availability across all known channels for a user.
   */
  getAllAvailability(userId: string, now?: number): ChannelAvailability[] {
    const currentTime = now ?? Date.now();
    const normalizedId = userId.toLowerCase().trim();
    const userMap = this.activity.get(normalizedId);

    if (!userMap) {
      return [];
    }

    return Array.from(userMap.keys())
      .map((ch) => this.getAvailability(normalizedId, ch, currentTime))
      .toSorted((a, b) => {
        // Sort by recency (most recent first)
        if (a.lastActiveAt === null) {
          return 1;
        }
        if (b.lastActiveAt === null) {
          return -1;
        }
        return b.lastActiveAt - a.lastActiveAt;
      });
  }

  /**
   * Get the most recently active channel for a user.
   */
  getMostRecentChannel(userId: string, now?: number): ChannelAvailability | null {
    const all = this.getAllAvailability(userId, now);
    return all.length > 0 ? all[0] : null;
  }

  /**
   * Get channels where the user is currently "active" (within active threshold).
   */
  getActiveChannels(userId: string, now?: number): ChannelAvailability[] {
    return this.getAllAvailability(userId, now).filter((a) => a.status === "active");
  }

  /**
   * Compute an availability score for a channel (0-1, higher = more available).
   */
  computeAvailabilityScore(userId: string, channelType: ChannelType, now?: number): number {
    const avail = this.getAvailability(userId, channelType, now);

    switch (avail.status) {
      case "active":
        return 1.0;
      case "recent":
        return 0.7;
      case "stale":
        return 0.3;
      case "inactive":
        return 0.1;
      case "unknown":
        return 0.0;
      default:
        return 0.0;
    }
  }

  /**
   * Get raw activity data for a user on a channel.
   */
  getActivity(userId: string, channelType: ChannelType): UserChannelActivity | undefined {
    const normalizedId = userId.toLowerCase().trim();
    const userMap = this.activity.get(normalizedId);
    if (!userMap) {
      return undefined;
    }
    const entry = userMap.get(channelType);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Get all tracked users.
   */
  getTrackedUsers(): string[] {
    return Array.from(this.activity.keys());
  }

  /**
   * Update staleness thresholds.
   */
  setThresholds(thresholds: Partial<StalenessThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  /**
   * Get current thresholds.
   */
  getThresholds(): StalenessThresholds {
    return { ...this.thresholds };
  }

  /**
   * Clear all activity data.
   */
  clear(): void {
    this.activity.clear();
  }

  /**
   * Clear activity for a specific user.
   */
  clearUser(userId: string): boolean {
    return this.activity.delete(userId.toLowerCase().trim());
  }

  /**
   * Number of tracked users.
   */
  get size(): number {
    return this.activity.size;
  }

  /**
   * Serialize all activity data for persistence.
   */
  toJSON(): Record<string, UserChannelActivity[]> {
    const result: Record<string, UserChannelActivity[]> = {};
    for (const [userId, channelMap] of this.activity) {
      result[userId] = Array.from(channelMap.values());
    }
    return result;
  }

  /**
   * Load activity data from serialized form.
   */
  static fromJSON(
    data: Record<string, UserChannelActivity[]>,
    thresholds?: Partial<StalenessThresholds>,
  ): UserAvailabilityTracker {
    const tracker = new UserAvailabilityTracker(thresholds);
    for (const [userId, activities] of Object.entries(data)) {
      for (const activity of activities) {
        if (isUserChannelActivity(activity)) {
          tracker.recordActivity({
            userId,
            channelType: activity.channelType,
            timestamp: activity.lastActiveAt,
            destination: activity.destination,
            accountId: activity.accountId,
          });
          // Restore message count
          const userMap = tracker.activity.get(userId.toLowerCase().trim());
          if (userMap) {
            const entry = userMap.get(activity.channelType);
            if (entry) {
              entry.messageCount = activity.messageCount;
            }
          }
        }
      }
    }
    return tracker;
  }

  /**
   * Classify an age (ms since last activity) into a status.
   */
  private classifyAge(ageMs: number): AvailabilityStatus {
    if (ageMs <= this.thresholds.activeMs) {
      return "active";
    }
    if (ageMs <= this.thresholds.recentMs) {
      return "recent";
    }
    if (ageMs <= this.thresholds.staleMs) {
      return "stale";
    }
    return "inactive";
  }
}

/**
 * Type guard for UserChannelActivity.
 */
function isUserChannelActivity(value: unknown): value is UserChannelActivity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.channelType === "string" &&
    typeof obj.lastActiveAt === "number" &&
    typeof obj.messageCount === "number"
  );
}
