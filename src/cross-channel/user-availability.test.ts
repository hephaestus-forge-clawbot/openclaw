/**
 * User Availability Tracker Tests (Hephie Phase 3.4)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { UserAvailabilityTracker } from "./user-availability.js";

describe("UserAvailabilityTracker", () => {
  let tracker: UserAvailabilityTracker;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    tracker = new UserAvailabilityTracker();
  });

  // ── Recording Activity ──────────────────────────────────────────────

  it("records activity for a user on a channel", () => {
    const result = tracker.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW,
      destination: "chat_123",
    });

    expect(result.channelType).toBe("telegram");
    expect(result.lastActiveAt).toBe(NOW);
    expect(result.messageCount).toBe(1);
    expect(result.destination).toBe("chat_123");
  });

  it("updates existing activity with later timestamp", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const result = tracker.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW + 60_000,
    });

    expect(result.messageCount).toBe(2);
    expect(result.lastActiveAt).toBe(NOW + 60_000);
  });

  it("does not regress timestamp with earlier message", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW + 1000 });
    const result = tracker.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW,
    });

    expect(result.lastActiveAt).toBe(NOW + 1000);
  });

  it("tracks multiple channels independently", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    tracker.recordActivity({ userId: "alice", channelType: "slack", timestamp: NOW + 1000 });

    const tg = tracker.getActivity("alice", "telegram");
    const sl = tracker.getActivity("alice", "slack");

    expect(tg?.messageCount).toBe(1);
    expect(sl?.messageCount).toBe(1);
    expect(sl?.lastActiveAt).toBe(NOW + 1000);
  });

  it("normalizes user IDs to lowercase", () => {
    tracker.recordActivity({ userId: "Alice", channelType: "telegram", timestamp: NOW });
    const result = tracker.getActivity("alice", "telegram");
    expect(result).toBeDefined();
    expect(result!.lastActiveAt).toBe(NOW);
  });

  // ── Availability Status ─────────────────────────────────────────────

  it("classifies 'active' status within 5 minutes", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const avail = tracker.getAvailability("alice", "telegram", NOW + 2 * 60 * 1000); // 2 min later

    expect(avail.status).toBe("active");
    expect(avail.ageSinceActiveMs).toBe(2 * 60 * 1000);
  });

  it("classifies 'recent' status within 1 hour", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const avail = tracker.getAvailability("alice", "telegram", NOW + 30 * 60 * 1000); // 30 min later

    expect(avail.status).toBe("recent");
  });

  it("classifies 'stale' status within 24 hours", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const avail = tracker.getAvailability("alice", "telegram", NOW + 6 * 60 * 60 * 1000); // 6h later

    expect(avail.status).toBe("stale");
  });

  it("classifies 'inactive' status beyond 24 hours", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const avail = tracker.getAvailability("alice", "telegram", NOW + 48 * 60 * 60 * 1000); // 48h later

    expect(avail.status).toBe("inactive");
  });

  it("returns 'unknown' for untracked user", () => {
    const avail = tracker.getAvailability("nobody", "telegram", NOW);
    expect(avail.status).toBe("unknown");
    expect(avail.lastActiveAt).toBeNull();
    expect(avail.ageSinceActiveMs).toBeNull();
  });

  it("returns 'unknown' for untracked channel", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const avail = tracker.getAvailability("alice", "discord", NOW);
    expect(avail.status).toBe("unknown");
  });

  // ── Availability Queries ────────────────────────────────────────────

  it("getAllAvailability returns channels sorted by recency", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    tracker.recordActivity({ userId: "alice", channelType: "slack", timestamp: NOW + 5000 });
    tracker.recordActivity({ userId: "alice", channelType: "discord", timestamp: NOW + 1000 });

    const all = tracker.getAllAvailability("alice", NOW + 10_000);
    expect(all).toHaveLength(3);
    expect(all[0].channelType).toBe("slack"); // most recent
    expect(all[1].channelType).toBe("discord");
    expect(all[2].channelType).toBe("telegram");
  });

  it("getMostRecentChannel returns the most recently active channel", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    tracker.recordActivity({ userId: "alice", channelType: "slack", timestamp: NOW + 5000 });

    const recent = tracker.getMostRecentChannel("alice", NOW + 10_000);
    expect(recent).not.toBeNull();
    expect(recent!.channelType).toBe("slack");
  });

  it("getMostRecentChannel returns null for unknown user", () => {
    const recent = tracker.getMostRecentChannel("nobody");
    expect(recent).toBeNull();
  });

  it("getActiveChannels returns only active channels", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    tracker.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - 2 * 60 * 60 * 1000, // 2 hours ago
    });

    const active = tracker.getActiveChannels("alice", NOW + 60_000); // 1 min later
    expect(active).toHaveLength(1);
    expect(active[0].channelType).toBe("telegram");
  });

  // ── Availability Score ──────────────────────────────────────────────

  it("gives score 1.0 for active channel", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const score = tracker.computeAvailabilityScore("alice", "telegram", NOW + 60_000);
    expect(score).toBe(1.0);
  });

  it("gives score 0.7 for recent channel", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const score = tracker.computeAvailabilityScore("alice", "telegram", NOW + 30 * 60 * 1000);
    expect(score).toBe(0.7);
  });

  it("gives score 0.3 for stale channel", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const score = tracker.computeAvailabilityScore("alice", "telegram", NOW + 6 * 60 * 60 * 1000);
    expect(score).toBe(0.3);
  });

  it("gives score 0.0 for unknown channel", () => {
    const score = tracker.computeAvailabilityScore("nobody", "telegram", NOW);
    expect(score).toBe(0.0);
  });

  // ── Custom Thresholds ───────────────────────────────────────────────

  it("respects custom staleness thresholds", () => {
    tracker = new UserAvailabilityTracker({
      activeMs: 10_000, // 10 seconds
      recentMs: 60_000, // 1 minute
      staleMs: 300_000, // 5 minutes
    });

    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });

    // 15 seconds later → "recent" (not "active" with custom threshold)
    const avail = tracker.getAvailability("alice", "telegram", NOW + 15_000);
    expect(avail.status).toBe("recent");
  });

  // ── Serialization ──────────────────────────────────────────────────

  it("serializes and deserializes correctly", () => {
    tracker.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW,
      destination: "chat_123",
    });
    tracker.recordActivity({ userId: "alice", channelType: "slack", timestamp: NOW + 1000 });
    tracker.recordActivity({ userId: "bob", channelType: "discord", timestamp: NOW + 2000 });

    const json = tracker.toJSON();
    const restored = UserAvailabilityTracker.fromJSON(json);

    expect(restored.size).toBe(2);
    const aliceTg = restored.getActivity("alice", "telegram");
    expect(aliceTg?.destination).toBe("chat_123");
    expect(aliceTg?.messageCount).toBe(1);
  });

  // ── Cleanup ─────────────────────────────────────────────────────────

  it("clears all data", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    tracker.clear();
    expect(tracker.size).toBe(0);
  });

  it("clears data for a specific user", () => {
    tracker.recordActivity({ userId: "alice", channelType: "telegram", timestamp: NOW });
    tracker.recordActivity({ userId: "bob", channelType: "slack", timestamp: NOW });

    expect(tracker.clearUser("alice")).toBe(true);
    expect(tracker.size).toBe(1);
    expect(tracker.getActivity("alice", "telegram")).toBeUndefined();
    expect(tracker.getActivity("bob", "slack")).toBeDefined();
  });
});
