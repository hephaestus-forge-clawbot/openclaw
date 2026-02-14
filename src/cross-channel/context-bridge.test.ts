/**
 * Tests for Cross-Channel Context Bridge (Hephie Phase 3.1)
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { SessionInfo } from "./context-bridge.js";
import type { CrossChannelContext } from "./types.js";
import { ChannelHistoryTracker } from "./channel-history.js";
import { assembleCrossChannelContext, formatCrossChannelContext } from "./context-bridge.js";
import { IdentityStore } from "./identity-map.js";

describe("assembleCrossChannelContext", () => {
  let identityStore: IdentityStore;
  const NOW = 1700000000000;

  beforeEach(() => {
    identityStore = new IdentityStore();
    identityStore.registerUser("alice", [
      { channelType: "telegram", userId: "123" },
      { channelType: "slack", userId: "U456" },
    ]);
  });

  function makeSession(
    overrides: Partial<SessionInfo> & {
      channels?: Array<{ type: string; lastTs: number; topic?: string; count?: number }>;
    },
  ): SessionInfo {
    const tracker = new ChannelHistoryTracker();
    for (const ch of overrides.channels ?? []) {
      // Set first message to be 10 minutes before last message
      tracker.recordMessage({
        channelType: ch.type,
        timestamp: ch.lastTs - 600_000,
        topic: ch.topic,
      });
      // Then the most recent
      for (let i = 1; i < (ch.count ?? 1); i++) {
        tracker.recordMessage({
          channelType: ch.type,
          timestamp: ch.lastTs - (ch.count! - i) * 60_000,
        });
      }
      tracker.recordMessage({
        channelType: ch.type,
        timestamp: ch.lastTs,
        topic: ch.topic,
      });
    }

    return {
      sessionKey: overrides.sessionKey ?? "session-1",
      channelHistory: tracker,
      person: overrides.person ?? "alice",
      lastTopic: overrides.lastTopic,
    };
  }

  it("should return empty context when disabled", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        channels: [
          { type: "telegram", lastTs: NOW - 60_000 },
          { type: "slack", lastTs: NOW - 30_000 },
        ],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      config: { enabled: false },
      now: NOW,
    });

    expect(result.enabled).toBe(false);
    expect(result.otherChannelActivity).toHaveLength(0);
    expect(result.formattedContext).toBe("");
  });

  it("should find cross-channel activity", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        channels: [
          { type: "telegram", lastTs: NOW - 60_000, topic: "ML experiments" },
          { type: "slack", lastTs: NOW - 30_000, topic: "project planning" },
        ],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      now: NOW,
    });

    expect(result.enabled).toBe(true);
    expect(result.otherChannelActivity).toHaveLength(1);
    expect(result.otherChannelActivity[0].channelType).toBe("slack");
    expect(result.otherChannelActivity[0].summary).toContain("project planning");
  });

  it("should not include current channel in other activity", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        channels: [{ type: "telegram", lastTs: NOW - 60_000 }],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      now: NOW,
    });

    expect(result.otherChannelActivity).toHaveLength(0);
  });

  it("should filter out old activity beyond maxAgeMs", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        channels: [
          { type: "telegram", lastTs: NOW - 60_000 },
          { type: "slack", lastTs: NOW - 25 * 60 * 60 * 1000 }, // 25 hours ago
        ],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      config: { maxAgeMs: 24 * 60 * 60 * 1000 }, // 24h
      now: NOW,
    });

    expect(result.otherChannelActivity).toHaveLength(0);
  });

  it("should respect maxEntries limit", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        channels: [
          { type: "telegram", lastTs: NOW - 60_000 },
          { type: "slack", lastTs: NOW - 30_000 },
          { type: "discord", lastTs: NOW - 20_000 },
          { type: "whatsapp", lastTs: NOW - 10_000 },
        ],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      config: { maxEntries: 2 },
      now: NOW,
    });

    expect(result.otherChannelActivity).toHaveLength(2);
  });

  it("should sort by relevance (recency)", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        channels: [
          { type: "telegram", lastTs: NOW - 60_000 },
          { type: "slack", lastTs: NOW - 10 * 60 * 60 * 1000 }, // 10h ago
          { type: "discord", lastTs: NOW - 30_000 },
        ],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      now: NOW,
    });

    expect(result.otherChannelActivity[0].channelType).toBe("discord");
    expect(result.otherChannelActivity[1].channelType).toBe("slack");
  });

  it("should only include sessions for the specified user", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        person: "alice",
        channels: [
          { type: "telegram", lastTs: NOW - 60_000 },
          { type: "slack", lastTs: NOW - 30_000, topic: "alice stuff" },
        ],
      }),
      makeSession({
        person: "bob",
        sessionKey: "session-2",
        channels: [
          { type: "telegram", lastTs: NOW - 60_000 },
          { type: "discord", lastTs: NOW - 30_000, topic: "bob stuff" },
        ],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      now: NOW,
    });

    expect(result.otherChannelActivity).toHaveLength(1);
    expect(result.otherChannelActivity[0].channelType).toBe("slack");
  });

  it("should aggregate across multiple sessions for same user", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        person: "alice",
        sessionKey: "session-1",
        channels: [
          { type: "telegram", lastTs: NOW - 60_000 },
          { type: "slack", lastTs: NOW - 30_000, topic: "work" },
        ],
      }),
      makeSession({
        person: "alice",
        sessionKey: "session-2",
        channels: [{ type: "discord", lastTs: NOW - 15_000, topic: "gaming" }],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      now: NOW,
    });

    expect(result.otherChannelActivity).toHaveLength(2);
    const channels = result.otherChannelActivity.map((e) => e.channelType);
    expect(channels).toContain("slack");
    expect(channels).toContain("discord");
  });

  it("should filter by minimum relevance", () => {
    const sessions: SessionInfo[] = [
      makeSession({
        channels: [
          { type: "telegram", lastTs: NOW - 60_000 },
          { type: "slack", lastTs: NOW - 23 * 60 * 60 * 1000 }, // 23h ago, low relevance
        ],
      }),
    ];

    const result = assembleCrossChannelContext({
      currentUser: "alice",
      currentChannel: "telegram",
      activeSessions: sessions,
      identityStore,
      config: { minRelevance: 0.5 },
      now: NOW,
    });

    // 23h ago out of 24h window => relevance ≈ 0.04, should be filtered
    expect(result.otherChannelActivity).toHaveLength(0);
  });
});

describe("formatCrossChannelContext", () => {
  it("should format context with entries", () => {
    const context: CrossChannelContext = {
      currentUser: "alice",
      currentChannel: "telegram",
      enabled: true,
      otherChannelActivity: [
        {
          channelType: "slack",
          timestamp: Date.now() - 30 * 60 * 1000,
          summary: "discussing project planning",
          sessionKey: "session-1",
          relevance: 0.9,
        },
      ],
      formattedContext: "",
    };

    const formatted = formatCrossChannelContext(context);
    expect(formatted).toContain("[Cross-Channel Context for alice]");
    expect(formatted).toContain("Slack");
    expect(formatted).toContain("discussing project planning");
  });

  it("should return empty string when disabled", () => {
    const context: CrossChannelContext = {
      currentUser: "alice",
      currentChannel: "telegram",
      enabled: false,
      otherChannelActivity: [],
      formattedContext: "",
    };

    expect(formatCrossChannelContext(context)).toBe("");
  });

  it("should return empty string when no activity", () => {
    const context: CrossChannelContext = {
      currentUser: "alice",
      currentChannel: "telegram",
      enabled: true,
      otherChannelActivity: [],
      formattedContext: "",
    };

    expect(formatCrossChannelContext(context)).toBe("");
  });
});
