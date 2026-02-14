/**
 * Tests for Reply Router (Hephie Phase 3.2)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { ReplyRouter } from "./reply-router.js";

describe("ReplyRouter", () => {
  let router: ReplyRouter;

  beforeEach(() => {
    router = new ReplyRouter();
  });

  it("should start empty", () => {
    expect(router.size).toBe(0);
    expect(router.getRoute("session-1")).toBeUndefined();
    expect(router.getAllRoutes().size).toBe(0);
  });

  it("should update and retrieve a route", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      timestamp: 1000,
    });

    const route = router.getRoute("session-1");
    expect(route).toBeDefined();
    expect(route!.channel).toBe("telegram");
    expect(route!.to).toBe("12345");
    expect(route!.updatedAt).toBe(1000);
  });

  it("should update route when same session messages from different channel", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      timestamp: 1000,
    });

    router.updateRoute({
      sessionKey: "session-1",
      channel: "slack",
      to: "C123",
      timestamp: 2000,
    });

    const route = router.getRoute("session-1");
    expect(route!.channel).toBe("slack");
    expect(route!.to).toBe("C123");
    expect(route!.updatedAt).toBe(2000);
  });

  it("should track account ID and thread ID", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      accountId: "bot-1",
      threadId: "thread-99",
      timestamp: 1000,
    });

    const route = router.getRoute("session-1");
    expect(route!.accountId).toBe("bot-1");
    expect(route!.threadId).toBe("thread-99");
  });

  it("should track person → session mapping", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      person: "Father",
      timestamp: 1000,
    });

    const route = router.getRouteForPerson("Father");
    expect(route).toBeDefined();
    expect(route!.channel).toBe("telegram");
    expect(route!.to).toBe("12345");
  });

  it("should be case-insensitive for person lookup", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      person: "Father",
      timestamp: 1000,
    });

    expect(router.getRouteForPerson("father")).toBeDefined();
    expect(router.getRouteForPerson("FATHER")).toBeDefined();
    expect(router.getRouteForPerson("  Father  ")).toBeDefined();
  });

  it("should update person's session when they message from a new session", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      person: "Father",
      timestamp: 1000,
    });

    router.updateRoute({
      sessionKey: "session-2",
      channel: "slack",
      to: "C123",
      person: "Father",
      timestamp: 2000,
    });

    const route = router.getRouteForPerson("Father");
    expect(route!.channel).toBe("slack");
    expect(route!.to).toBe("C123");
  });

  it("should get session key for person", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      person: "Father",
      timestamp: 1000,
    });

    expect(router.getSessionKeyForPerson("Father")).toBe("session-1");
    expect(router.getSessionKeyForPerson("Unknown")).toBeUndefined();
  });

  it("should remove a route", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      timestamp: 1000,
    });

    expect(router.removeRoute("session-1")).toBe(true);
    expect(router.getRoute("session-1")).toBeUndefined();
    expect(router.size).toBe(0);
  });

  it("should return false when removing non-existent route", () => {
    expect(router.removeRoute("no-such-session")).toBe(false);
  });

  it("should track multiple sessions independently", () => {
    router.updateRoute({
      sessionKey: "session-1",
      channel: "telegram",
      to: "12345",
      timestamp: 1000,
    });

    router.updateRoute({
      sessionKey: "session-2",
      channel: "slack",
      to: "C123",
      timestamp: 2000,
    });

    expect(router.size).toBe(2);
    expect(router.getRoute("session-1")!.channel).toBe("telegram");
    expect(router.getRoute("session-2")!.channel).toBe("slack");
  });

  it("should return all routes", () => {
    router.updateRoute({ sessionKey: "s1", channel: "telegram", to: "1" });
    router.updateRoute({ sessionKey: "s2", channel: "slack", to: "2" });

    const all = router.getAllRoutes();
    expect(all.size).toBe(2);
    expect(all.get("s1")!.channel).toBe("telegram");
    expect(all.get("s2")!.channel).toBe("slack");
  });

  it("should clear all routes", () => {
    router.updateRoute({ sessionKey: "s1", channel: "telegram", to: "1" });
    router.updateRoute({ sessionKey: "s2", channel: "slack", to: "2", person: "Alice" });

    router.clear();
    expect(router.size).toBe(0);
    expect(router.getRoute("s1")).toBeUndefined();
    expect(router.getRouteForPerson("Alice")).toBeUndefined();
  });

  it("should return copies, not references", () => {
    router.updateRoute({ sessionKey: "s1", channel: "telegram", to: "1", timestamp: 1000 });
    const route = router.getRoute("s1");
    route!.to = "modified";

    expect(router.getRoute("s1")!.to).toBe("1");
  });

  it("should use current time when no timestamp provided", () => {
    const before = Date.now();
    router.updateRoute({ sessionKey: "s1", channel: "telegram", to: "1" });
    const after = Date.now();

    const route = router.getRoute("s1");
    expect(route!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(route!.updatedAt).toBeLessThanOrEqual(after);
  });
});
