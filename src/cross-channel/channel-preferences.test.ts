/**
 * Channel Preference Learning Tests (Hephie Phase 3.4)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ChannelPreferenceLearner } from "./channel-preferences.js";

describe("ChannelPreferenceLearner", () => {
  let learner: ChannelPreferenceLearner;
  const NOW = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    learner = new ChannelPreferenceLearner();
  });

  // ── Recording Observations ──────────────────────────────────────────

  it("records message observations", () => {
    learner.recordObservation({ userId: "alice", channelType: "telegram", timestamp: NOW });
    const obs = learner.getObservations("alice");
    expect(obs).toHaveLength(1);
    expect(obs[0].channelType).toBe("telegram");
  });

  it("normalizes user IDs", () => {
    learner.recordObservation({ userId: "Alice", channelType: "telegram", timestamp: NOW });
    const obs = learner.getObservations("alice");
    expect(obs).toHaveLength(1);
  });

  it("records message type with observation", () => {
    learner.recordObservation({
      userId: "alice",
      channelType: "slack",
      messageType: "code",
      timestamp: NOW,
    });
    const obs = learner.getObservations("alice");
    expect(obs[0].messageType).toBe("code");
  });

  it("enforces window size limit", () => {
    learner = new ChannelPreferenceLearner({ windowSize: 5 });
    for (let i = 0; i < 10; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW + i * 1000,
      });
    }
    expect(learner.getObservations("alice")).toHaveLength(5);
  });

  // ── Computing Preferences ──────────────────────────────────────────

  it("returns null when too few observations", () => {
    learner.recordObservation({ userId: "alice", channelType: "telegram", timestamp: NOW });
    learner.recordObservation({ userId: "alice", channelType: "telegram", timestamp: NOW + 1000 });

    // Default minObservations is 3
    const prefs = learner.getPreferences("alice", NOW);
    expect(prefs).toBeNull();
  });

  it("computes preferences with enough observations", () => {
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW + i * 1000,
      });
    }

    const prefs = learner.getPreferences("alice", NOW + 10_000);
    expect(prefs).not.toBeNull();
    expect(prefs!.preferences).toHaveLength(1);
    expect(prefs!.preferences[0].channelType).toBe("telegram");
    expect(prefs!.preferences[0].weight).toBeCloseTo(1.0, 1);
    expect(prefs!.totalMessages).toBe(5);
  });

  it("ranks channels by usage frequency", () => {
    // Alice uses Telegram 7 times, Slack 3 times
    for (let i = 0; i < 7; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW + i * 1000,
      });
    }
    for (let i = 0; i < 3; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "slack",
        timestamp: NOW + (7 + i) * 1000,
      });
    }

    const prefs = learner.getPreferences("alice", NOW + 20_000);
    expect(prefs!.preferences[0].channelType).toBe("telegram");
    expect(prefs!.preferences[1].channelType).toBe("slack");
    expect(prefs!.preferences[0].weight).toBeGreaterThan(prefs!.preferences[1].weight);
  });

  it("applies time decay — recent messages weigh more", () => {
    // 5 old Telegram messages (20 days ago)
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW - 20 * DAY + i * 1000,
      });
    }
    // 5 recent Slack messages (today)
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "slack",
        timestamp: NOW + i * 1000,
      });
    }

    const prefs = learner.getPreferences("alice", NOW + 10_000);
    expect(prefs!.preferences[0].channelType).toBe("slack");
    // Slack should have higher weight despite same count
    expect(prefs!.preferences[0].weight).toBeGreaterThan(prefs!.preferences[1].weight);
  });

  it("tracks common message types per channel", () => {
    for (let i = 0; i < 3; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "slack",
        messageType: "code",
        timestamp: NOW + i * 1000,
      });
    }
    learner.recordObservation({
      userId: "alice",
      channelType: "slack",
      messageType: "text",
      timestamp: NOW + 5000,
    });

    const prefs = learner.getPreferences("alice", NOW + 10_000);
    const slackPref = prefs!.preferences.find((p) => p.channelType === "slack");
    expect(slackPref!.commonMessageTypes).toContain("code");
  });

  it("tracks active hours", () => {
    // Record at known hours
    const base = new Date(2024, 0, 15, 9, 0, 0).getTime(); // 9 AM
    for (let i = 0; i < 4; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: base + i * 1000,
      });
    }

    const prefs = learner.getPreferences("alice", base + 10_000);
    expect(prefs!.preferences[0].activeHours).toContain(9);
  });

  // ── Channel Weight ──────────────────────────────────────────────────

  it("getChannelWeight returns weight for known channel", () => {
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW + i * 1000,
      });
    }

    const weight = learner.getChannelWeight("alice", "telegram", NOW + 10_000);
    expect(weight).toBeGreaterThan(0);
  });

  it("getChannelWeight returns 0 for unknown channel", () => {
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW + i * 1000,
      });
    }

    const weight = learner.getChannelWeight("alice", "discord", NOW + 10_000);
    expect(weight).toBe(0);
  });

  it("getChannelWeight returns 0 when no preferences computed", () => {
    const weight = learner.getChannelWeight("nobody", "telegram");
    expect(weight).toBe(0);
  });

  // ── Top Channel ─────────────────────────────────────────────────────

  it("getTopChannel returns the most preferred channel", () => {
    for (let i = 0; i < 8; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW + i * 1000,
      });
    }
    for (let i = 0; i < 3; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "slack",
        timestamp: NOW + (8 + i) * 1000,
      });
    }

    const top = learner.getTopChannel("alice", NOW + 20_000);
    expect(top).not.toBeNull();
    expect(top!.channelType).toBe("telegram");
  });

  it("getTopChannel returns null for unknown user", () => {
    expect(learner.getTopChannel("nobody")).toBeNull();
  });

  // ── Caching ─────────────────────────────────────────────────────────

  it("invalidates cache when new observation added", () => {
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW + i * 1000,
      });
    }

    const prefs1 = learner.getPreferences("alice", NOW + 10_000);
    expect(prefs1!.preferences).toHaveLength(1);

    // Add more on Slack → cache should be invalidated
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "slack",
        timestamp: NOW + (10 + i) * 1000,
      });
    }

    const prefs2 = learner.getPreferences("alice", NOW + 20_000);
    expect(prefs2!.preferences).toHaveLength(2);
  });

  // ── Serialization ──────────────────────────────────────────────────

  it("serializes and deserializes correctly", () => {
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        messageType: "text",
        timestamp: NOW + i * 1000,
      });
    }

    const json = learner.toJSON();
    const restored = ChannelPreferenceLearner.fromJSON(json);

    expect(restored.getTrackedUserCount()).toBe(1);
    const obs = restored.getObservations("alice");
    expect(obs).toHaveLength(5);
    expect(obs[0].channelType).toBe("telegram");
  });

  // ── Cleanup ─────────────────────────────────────────────────────────

  it("clears all data", () => {
    learner.recordObservation({ userId: "alice", channelType: "telegram", timestamp: NOW });
    learner.clear();
    expect(learner.getTrackedUserCount()).toBe(0);
  });

  it("clears data for specific user", () => {
    learner.recordObservation({ userId: "alice", channelType: "telegram", timestamp: NOW });
    learner.recordObservation({ userId: "bob", channelType: "slack", timestamp: NOW });

    expect(learner.clearUser("alice")).toBe(true);
    expect(learner.getTrackedUserCount()).toBe(1);
    expect(learner.getObservations("alice")).toHaveLength(0);
  });

  // ── Filters old observations ────────────────────────────────────────

  it("ignores observations older than maxObservationAge", () => {
    learner = new ChannelPreferenceLearner({
      maxObservationAgeMs: 7 * DAY, // 1 week
      minObservations: 1,
    });

    // All observations are 10 days old
    for (let i = 0; i < 5; i++) {
      learner.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW - 10 * DAY + i * 1000,
      });
    }

    const prefs = learner.getPreferences("alice", NOW);
    expect(prefs).not.toBeNull();
    expect(prefs!.totalMessages).toBe(0);
    expect(prefs!.preferences).toHaveLength(0);
  });
});
