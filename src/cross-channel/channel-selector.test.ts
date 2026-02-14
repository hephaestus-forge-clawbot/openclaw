/**
 * Smart Channel Selector Tests (Hephie Phase 3.4)
 *
 * Tests for the main selectBestChannel() API,
 * fallback chains, and integration with all signals.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ChannelAffinityMapper } from "./channel-affinity.js";
import { ChannelPreferenceLearner } from "./channel-preferences.js";
import { SmartChannelSelector } from "./channel-selector.js";
import { UserAvailabilityTracker } from "./user-availability.js";

describe("SmartChannelSelector", () => {
  let selector: SmartChannelSelector;
  let availability: UserAvailabilityTracker;
  let preferences: ChannelPreferenceLearner;
  let affinity: ChannelAffinityMapper;
  const NOW = 1_700_000_000_000;
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    availability = new UserAvailabilityTracker();
    preferences = new ChannelPreferenceLearner();
    affinity = new ChannelAffinityMapper();
    selector = new SmartChannelSelector({
      availability,
      preferences,
      affinity,
    });
    selector.registerChannels(["telegram", "slack", "discord", "whatsapp"]);
  });

  // ── Force Channel ───────────────────────────────────────────────────

  it("returns forced channel when forceChannel is set", () => {
    const result = selector.selectBestChannel({
      userId: "alice",
      forceChannel: "discord",
      now: NOW,
    });

    expect(result.best).not.toBeNull();
    expect(result.best!.channel).toBe("discord");
    expect(result.best!.score).toBe(1.0);
    expect(result.best!.reasons).toContain("Forced channel override");
    expect(result.overridesReplyChannel).toBe(true);
  });

  // ── No Data ─────────────────────────────────────────────────────────

  it("returns recommendations even with no user data", () => {
    const result = selector.selectBestChannel({
      userId: "alice",
      now: NOW,
    });

    // Should still return registered channels
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  // ── Availability Signal ─────────────────────────────────────────────

  it("prefers channel where user is currently active", () => {
    // Alice was on Telegram 2 minutes ago, Slack 3 hours ago
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - 2 * MINUTE,
      destination: "chat_tg",
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - 3 * HOUR,
      destination: "chat_sl",
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      now: NOW,
    });

    expect(result.best!.channel).toBe("telegram");
    expect(result.best!.destination).toBe("chat_tg");
  });

  // ── Preference Signal ──────────────────────────────────────────────

  it("considers user preferences in scoring", () => {
    // Give preference more weight for this test
    selector.setConfig({
      weights: { preference: 0.6, availability: 0.2, affinity: 0.1, recency: 0.1 },
    });

    // Alice heavily prefers Slack (many recent messages)
    for (let i = 0; i < 20; i++) {
      preferences.recordObservation({
        userId: "alice",
        channelType: "slack",
        timestamp: NOW - i * MINUTE,
      });
    }
    for (let i = 0; i < 3; i++) {
      preferences.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW - i * MINUTE,
      });
    }

    // Both channels are equally available
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });

    // Verify preferences were learned
    const prefs = preferences.getPreferences("alice", NOW);
    expect(prefs).not.toBeNull();
    expect(prefs!.preferences.length).toBeGreaterThanOrEqual(2);

    const slackPrefWeight = preferences.getChannelWeight("alice", "slack", NOW);
    const tgPrefWeight = preferences.getChannelWeight("alice", "telegram", NOW);
    expect(slackPrefWeight).toBeGreaterThan(tgPrefWeight);

    const result = selector.selectBestChannel({
      userId: "alice",
      now: NOW,
    });

    // Slack should score higher due to preference
    const slackRec = result.recommendations.find((r) => r.channel === "slack");
    const tgRec = result.recommendations.find((r) => r.channel === "telegram");
    expect(slackRec!.score).toBeGreaterThan(tgRec!.score);
  });

  // ── Affinity Signal ────────────────────────────────────────────────

  it("prefers Slack for code messages", () => {
    // Both channels equally available
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      messageType: "code",
      now: NOW,
    });

    const slackRec = result.recommendations.find((r) => r.channel === "slack");
    const tgRec = result.recommendations.find((r) => r.channel === "telegram");
    expect(slackRec!.score).toBeGreaterThan(tgRec!.score);
  });

  it("avoids WhatsApp for code messages", () => {
    availability.recordActivity({
      userId: "alice",
      channelType: "whatsapp",
      timestamp: NOW - MINUTE,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      messageType: "code",
      now: NOW,
    });

    const waRec = result.recommendations.find((r) => r.channel === "whatsapp");
    // WhatsApp should have very low affinity score for code
    expect(waRec!.score).toBeLessThan(0.5);
  });

  it("prefers Telegram for file sharing", () => {
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - MINUTE,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      messageType: "file",
      now: NOW,
    });

    const tgRec = result.recommendations.find((r) => r.channel === "telegram");
    const slRec = result.recommendations.find((r) => r.channel === "slack");
    expect(tgRec!.score).toBeGreaterThan(slRec!.score);
  });

  // ── Recency Signal ─────────────────────────────────────────────────

  it("gives bonus to current reply channel", () => {
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - MINUTE,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      currentReplyChannel: "telegram",
      now: NOW,
    });

    const tgRec = result.recommendations.find((r) => r.channel === "telegram");
    const slRec = result.recommendations.find((r) => r.channel === "slack");
    expect(tgRec!.score).toBeGreaterThan(slRec!.score);
  });

  // ── Urgency ─────────────────────────────────────────────────────────

  it("urgency=critical heavily weights availability", () => {
    // Alice active on Telegram, inactive on Slack
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - 2 * DAY,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      urgency: "critical",
      now: NOW,
    });

    expect(result.best!.channel).toBe("telegram");
    expect(result.reasoning).toContain("Urgency: critical");
  });

  it("urgency=high boosts availability weight", () => {
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - 5 * HOUR,
    });

    const normalResult = selector.selectBestChannel({
      userId: "alice",
      urgency: "normal",
      now: NOW,
    });

    const urgentResult = selector.selectBestChannel({
      userId: "alice",
      urgency: "high",
      now: NOW,
    });

    // Both should prefer telegram, but urgent should have bigger gap
    const normalTg = normalResult.recommendations.find((r) => r.channel === "telegram");
    const normalSl = normalResult.recommendations.find((r) => r.channel === "slack");
    const urgentTg = urgentResult.recommendations.find((r) => r.channel === "telegram");
    const urgentSl = urgentResult.recommendations.find((r) => r.channel === "slack");

    const normalGap = normalTg!.score - normalSl!.score;
    const urgentGap = urgentTg!.score - urgentSl!.score;
    expect(urgentGap).toBeGreaterThanOrEqual(normalGap);
  });

  // ── Fallback Chain ──────────────────────────────────────────────────

  it("configures fallback chain per user", () => {
    selector.setFallbackChain({
      userId: "alice",
      channelOrder: ["telegram", "whatsapp", "slack"],
      destinations: { telegram: "tg_123", whatsapp: "wa_456", slack: "sl_789" },
    });

    const chain = selector.getFallbackChain("alice");
    expect(chain).toBeDefined();
    expect(chain!.channelOrder).toEqual(["telegram", "whatsapp", "slack"]);
  });

  it("getNextFallback returns next channel in chain", () => {
    selector.setFallbackChain({
      userId: "alice",
      channelOrder: ["telegram", "whatsapp", "slack"],
      destinations: { whatsapp: "wa_456" },
    });

    const next = selector.getNextFallback("alice", "telegram");
    expect(next).not.toBeNull();
    expect(next!.channel).toBe("whatsapp");
    expect(next!.destination).toBe("wa_456");
  });

  it("getNextFallback returns null at end of chain", () => {
    selector.setFallbackChain({
      userId: "alice",
      channelOrder: ["telegram", "slack"],
    });

    const next = selector.getNextFallback("alice", "slack");
    expect(next).toBeNull();
  });

  it("getNextFallback returns null for unknown channel", () => {
    selector.setFallbackChain({
      userId: "alice",
      channelOrder: ["telegram", "slack"],
    });

    const next = selector.getNextFallback("alice", "discord");
    expect(next).toBeNull();
  });

  it("getNextFallback returns null when no chain configured", () => {
    const next = selector.getNextFallback("alice", "telegram");
    expect(next).toBeNull();
  });

  it("fallback chain influences ordering when scores are close", () => {
    selector.setFallbackChain({
      userId: "alice",
      channelOrder: ["slack", "telegram", "discord"],
    });

    // All channels equally available
    for (const ch of ["slack", "telegram", "discord"] as const) {
      availability.recordActivity({
        userId: "alice",
        channelType: ch,
        timestamp: NOW - MINUTE,
      });
    }

    const result = selector.selectBestChannel({
      userId: "alice",
      now: NOW,
    });

    // With equal scores, fallback chain order should be respected
    const channels = result.recommendations
      .filter((r) => ["slack", "telegram", "discord"].includes(r.channel))
      .map((r) => r.channel);

    // Slack should be first (fallback chain position 0)
    expect(channels[0]).toBe("slack");
  });

  // ── Override Logic ──────────────────────────────────────────────────

  it("overrides reply channel when better option exists", () => {
    // Alice is active on Telegram, stale on Slack
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - 10 * HOUR,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      currentReplyChannel: "slack",
      now: NOW,
    });

    // Should recommend Telegram and indicate override
    expect(result.best!.channel).toBe("telegram");
    expect(result.overridesReplyChannel).toBe(true);
    expect(result.reasoning).toContain("Overrides default reply channel");
  });

  it("does not override when current reply channel is best", () => {
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      currentReplyChannel: "telegram",
      now: NOW,
    });

    expect(result.best!.channel).toBe("telegram");
    expect(result.overridesReplyChannel).toBe(false);
  });

  it("does not override when override is disabled", () => {
    selector.setConfig({ enableOverride: false });

    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - 10 * HOUR,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      currentReplyChannel: "slack",
      now: NOW,
    });

    expect(result.overridesReplyChannel).toBe(false);
  });

  // ── Reasoning ───────────────────────────────────────────────────────

  it("includes message type in reasoning", () => {
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - MINUTE,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      messageType: "code",
      now: NOW,
    });

    expect(result.reasoning).toContain("code");
  });

  it("includes fallback channels in reasoning", () => {
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - 2 * MINUTE,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      now: NOW,
    });

    expect(result.reasoning).toContain("Fallbacks:");
  });

  it("best recommendation includes reasons array", () => {
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - MINUTE,
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      now: NOW,
    });

    expect(result.best!.reasons.length).toBeGreaterThan(0);
  });

  // ── Empty States ────────────────────────────────────────────────────

  it("handles user with no channels gracefully", () => {
    selector = new SmartChannelSelector({
      availability,
      preferences,
      affinity,
    });
    // No channels registered, no user data

    const result = selector.selectBestChannel({
      userId: "ghost",
      now: NOW,
    });

    expect(result.recommendations).toHaveLength(0);
    expect(result.best).toBeNull();
    expect(result.overridesReplyChannel).toBe(false);
  });

  // ── Config ──────────────────────────────────────────────────────────

  it("exposes components for inspection", () => {
    const components = selector.getComponents();
    expect(components.availability).toBe(availability);
    expect(components.preferences).toBe(preferences);
    expect(components.affinity).toBe(affinity);
  });

  it("exposes registered channels", () => {
    const channels = selector.getRegisteredChannels();
    expect(channels).toContain("telegram");
    expect(channels).toContain("slack");
  });

  it("can remove fallback chain", () => {
    selector.setFallbackChain({
      userId: "alice",
      channelOrder: ["telegram", "slack"],
    });
    expect(selector.removeFallbackChain("alice")).toBe(true);
    expect(selector.getFallbackChain("alice")).toBeUndefined();
  });

  // ── Combined Signals ───────────────────────────────────────────────

  it("combines all signals for realistic scenario", () => {
    // Scenario: Alice prefers Telegram, is active on Slack right now,
    // wants to send code (affinity: Slack), and current reply is Telegram

    // Preference: Telegram heavy
    for (let i = 0; i < 15; i++) {
      preferences.recordObservation({
        userId: "alice",
        channelType: "telegram",
        timestamp: NOW - i * HOUR,
      });
    }
    for (let i = 0; i < 5; i++) {
      preferences.recordObservation({
        userId: "alice",
        channelType: "slack",
        timestamp: NOW - i * HOUR,
      });
    }

    // Availability: Slack active, Telegram stale
    availability.recordActivity({
      userId: "alice",
      channelType: "slack",
      timestamp: NOW - 2 * MINUTE,
      destination: "sl_chat",
    });
    availability.recordActivity({
      userId: "alice",
      channelType: "telegram",
      timestamp: NOW - 5 * HOUR,
      destination: "tg_chat",
    });

    const result = selector.selectBestChannel({
      userId: "alice",
      messageType: "code",
      currentReplyChannel: "telegram",
      now: NOW,
    });

    // Slack should win: active + code affinity
    expect(result.best!.channel).toBe("slack");
    expect(result.best!.destination).toBe("sl_chat");
    expect(result.overridesReplyChannel).toBe(true);
    expect(result.recommendations.length).toBeGreaterThanOrEqual(2);
  });
});
