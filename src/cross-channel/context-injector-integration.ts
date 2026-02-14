/**
 * Integration: Cross-Channel Context with Memory Context Injector (Hephie Phase 3.1)
 *
 * Extends the existing ContextInjector to include cross-channel context
 * as an additional section in the assembled memory context.
 */

import type { ContextSection } from "../memory/context-injector.js";
import type { CrossChannelContext } from "./types.js";

/**
 * Build a ContextSection from cross-channel context data.
 *
 * This can be appended to the ContextInjector's assembled sections.
 */
export function buildCrossChannelSection(
  crossChannelContext: CrossChannelContext,
): ContextSection | null {
  if (!crossChannelContext.enabled) {
    return null;
  }
  if (crossChannelContext.otherChannelActivity.length === 0) {
    return null;
  }

  const content = crossChannelContext.formattedContext;
  if (!content) {
    return null;
  }

  const header = "## Cross-Channel Activity";
  const tokenCount = Math.ceil(content.length / 4); // rough: ~4 chars/token

  return {
    header,
    tier: "system",
    content,
    tokenCount,
    chunkIds: [],
    excludedCount: 0,
  };
}

/**
 * Check if cross-channel context should be injected based on privacy rules.
 *
 * Privacy rules:
 * 1. Cross-channel context is only injected for the same person.
 * 2. If respectPrivacy is true, only non-person-scoped summaries are injected.
 * 3. The user must have sessions on the other channels (identity verified).
 */
export function shouldInjectCrossChannelContext(params: {
  /** Is cross-channel injection enabled? */
  enabled: boolean;
  /** The current person we're talking to. */
  currentPerson?: string;
  /** The person the cross-channel data belongs to. */
  crossChannelPerson?: string;
  /** Whether to enforce privacy compartments. */
  respectPrivacy: boolean;
}): boolean {
  if (!params.enabled) {
    return false;
  }

  // No cross-channel context without identity
  if (!params.currentPerson || !params.crossChannelPerson) {
    return false;
  }

  // Privacy: only inject cross-channel context for the same person
  if (params.respectPrivacy) {
    return params.currentPerson.toLowerCase() === params.crossChannelPerson.toLowerCase();
  }

  return true;
}
