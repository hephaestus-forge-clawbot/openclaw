/**
 * Cross-Channel Reply Router (Hephie Phase 3.2)
 *
 * Tracks which channel a user most recently messaged from,
 * so replies always go to the right surface.
 *
 * Key principle: reply on the channel the message came from,
 * not wherever the session started.
 */

import type { ChannelType } from "./types.js";

/**
 * Tracks the current reply channel for each active conversation.
 * Key = session key or person canonical name.
 */
export interface ReplyRoute {
  /** The channel to reply on. */
  channel: ChannelType;

  /** The channel-specific destination (chat ID, user ID, etc.). */
  to: string;

  /** Optional account ID for multi-account channels. */
  accountId?: string;

  /** Optional thread ID for threaded conversations. */
  threadId?: string | number;

  /** When this route was last updated. */
  updatedAt: number;
}

/**
 * In-memory reply route tracker.
 *
 * Routes are updated on every inbound message and consulted
 * when sending outbound replies. The most recent route wins.
 */
export class ReplyRouter {
  /** sessionKey → ReplyRoute */
  private routes: Map<string, ReplyRoute> = new Map();

  /** personName → sessionKey (most recent) */
  private personSessions: Map<string, string> = new Map();

  /**
   * Update the reply route for a session when a message arrives.
   */
  updateRoute(params: {
    sessionKey: string;
    channel: ChannelType;
    to: string;
    accountId?: string;
    threadId?: string | number;
    person?: string;
    timestamp?: number;
  }): ReplyRoute {
    const route: ReplyRoute = {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      threadId: params.threadId,
      updatedAt: params.timestamp ?? Date.now(),
    };

    this.routes.set(params.sessionKey, route);

    // Also track person → session mapping
    if (params.person) {
      const normalized = params.person.toLowerCase().trim();
      this.personSessions.set(normalized, params.sessionKey);
    }

    return { ...route };
  }

  /**
   * Get the current reply route for a session.
   */
  getRoute(sessionKey: string): ReplyRoute | undefined {
    const route = this.routes.get(sessionKey);
    return route ? { ...route } : undefined;
  }

  /**
   * Get the current reply route for a person (across all sessions).
   * Returns the most recently active session's route.
   */
  getRouteForPerson(personName: string): ReplyRoute | undefined {
    const normalized = personName.toLowerCase().trim();
    const sessionKey = this.personSessions.get(normalized);
    if (!sessionKey) {
      return undefined;
    }
    return this.getRoute(sessionKey);
  }

  /**
   * Get the session key for a person's most recent session.
   */
  getSessionKeyForPerson(personName: string): string | undefined {
    const normalized = personName.toLowerCase().trim();
    return this.personSessions.get(normalized);
  }

  /**
   * Remove a route (e.g., when a session ends).
   */
  removeRoute(sessionKey: string): boolean {
    return this.routes.delete(sessionKey);
  }

  /**
   * Get all active routes.
   */
  getAllRoutes(): Map<string, ReplyRoute> {
    return new Map(Array.from(this.routes.entries()).map(([k, v]) => [k, { ...v }]));
  }

  /**
   * Clear all routes.
   */
  clear(): void {
    this.routes.clear();
    this.personSessions.clear();
  }

  /**
   * Number of active routes.
   */
  get size(): number {
    return this.routes.size;
  }
}
