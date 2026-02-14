/**
 * Tests for Topic Similarity Engine (Hephie Phase 3.3)
 */

import { describe, expect, it } from "vitest";
import {
  extractTokens,
  extractEntities,
  computeTokenSimilarity,
  computeBigramSimilarity,
  computeTopicSimilarity,
  computeThreadSimilarity,
} from "./topic-similarity.js";

describe("Topic Similarity", () => {
  // ── Token Extraction ────────────────────────────────────────────────

  describe("extractTokens", () => {
    it("should extract meaningful tokens", () => {
      const tokens = extractTokens("Machine learning project update");
      expect(tokens).toContain("machine");
      expect(tokens).toContain("learning");
      expect(tokens).toContain("project");
      expect(tokens).toContain("update");
    });

    it("should remove stop words", () => {
      const tokens = extractTokens("The quick brown fox is in the garden");
      expect(tokens).not.toContain("the");
      expect(tokens).not.toContain("is");
      expect(tokens).not.toContain("in");
      expect(tokens).toContain("quick");
      expect(tokens).toContain("brown");
      expect(tokens).toContain("fox");
      expect(tokens).toContain("garden");
    });

    it("should handle empty text", () => {
      expect(extractTokens("")).toEqual([]);
      expect(extractTokens("the is a")).toEqual([]);
    });

    it("should handle code-like identifiers", () => {
      const tokens = extractTokens("Fix the cross-channel module");
      expect(tokens).toContain("fix");
      expect(tokens).toContain("cross-channel");
      expect(tokens).toContain("module");
    });
  });

  // ── Entity Extraction ──────────────────────────────────────────────

  describe("extractEntities", () => {
    it("should extract URLs (domains)", () => {
      const entities = extractEntities(
        "Check https://github.com/repo and https://slack.com/thread",
      );
      expect(entities).toContain("github.com");
      expect(entities).toContain("slack.com");
    });

    it("should extract mentions", () => {
      const entities = extractEntities("Hey @alice and @bob, check this");
      expect(entities).toContain("@alice");
      expect(entities).toContain("@bob");
    });

    it("should extract hashtags", () => {
      const entities = extractEntities("Working on #project-alpha #machine-learning");
      expect(entities).toContain("#project-alpha");
      expect(entities).toContain("#machine-learning");
    });

    it("should extract camelCase identifiers", () => {
      const entities = extractEntities("Updated the ThreadLinker and ContextBridge");
      expect(entities).toContain("threadlinker");
      expect(entities).toContain("contextbridge");
    });

    it("should extract snake_case identifiers", () => {
      const entities = extractEntities("The memory_chunks table needs migration");
      expect(entities).toContain("memory_chunks");
    });

    it("should deduplicate entities", () => {
      const entities = extractEntities("@alice said hi to @alice");
      const aliceCount = entities.filter((e) => e === "@alice").length;
      expect(aliceCount).toBe(1);
    });
  });

  // ── Token Similarity ──────────────────────────────────────────────

  describe("computeTokenSimilarity", () => {
    it("should return 0 for no overlap", () => {
      expect(computeTokenSimilarity(["cat", "dog"], ["fish", "bird"])).toBe(0);
    });

    it("should return 1 for identical token sets", () => {
      expect(computeTokenSimilarity(["machine", "learning"], ["machine", "learning"])).toBe(1);
    });

    it("should return high score for significant overlap", () => {
      const score = computeTokenSimilarity(
        ["machine", "learning", "model"],
        ["machine", "learning", "training"],
      );
      expect(score).toBeGreaterThan(0.3);
    });

    it("should return 0 for empty arrays", () => {
      expect(computeTokenSimilarity([], ["foo"])).toBe(0);
      expect(computeTokenSimilarity(["foo"], [])).toBe(0);
    });
  });

  // ── Bigram Similarity ─────────────────────────────────────────────

  describe("computeBigramSimilarity", () => {
    it("should detect shared phrases", () => {
      const score = computeBigramSimilarity(
        ["machine", "learning", "model"],
        ["deep", "machine", "learning"],
      );
      expect(score).toBeGreaterThan(0);
    });

    it("should return 0 for no shared bigrams", () => {
      const score = computeBigramSimilarity(["machine", "learning"], ["deep", "neural"]);
      expect(score).toBe(0);
    });

    it("should handle short arrays", () => {
      expect(computeBigramSimilarity(["one"], ["one"])).toBe(0);
    });
  });

  // ── Topic Similarity ──────────────────────────────────────────────

  describe("computeTopicSimilarity", () => {
    it("should detect similar topics", () => {
      const score = computeTopicSimilarity(
        "We need to update the machine learning model",
        "The machine learning model update is ready",
      );
      expect(score).toBeGreaterThan(0.3);
    });

    it("should detect unrelated topics", () => {
      const score = computeTopicSimilarity(
        "I'm going to the grocery store",
        "The TypeScript compiler has a new release",
      );
      expect(score).toBeLessThan(0.1);
    });

    it("should handle cross-channel topic matching", () => {
      const score = computeTopicSimilarity(
        "I sent you the document on Telegram",
        "Got the document you sent, reviewing now",
      );
      expect(score).toBeGreaterThan(0.1);
    });

    it("should score identical texts as highly similar", () => {
      const text = "Deploy the new API endpoint to production";
      const score = computeTopicSimilarity(text, text);
      expect(score).toBeGreaterThan(0.5);
    });

    it("should return 0 for empty texts", () => {
      expect(computeTopicSimilarity("", "hello")).toBe(0);
      expect(computeTopicSimilarity("hello", "")).toBe(0);
    });
  });

  // ── Thread Similarity ─────────────────────────────────────────────

  describe("computeThreadSimilarity", () => {
    it("should compare message against thread corpus", () => {
      const threadMessages = [
        "Let's discuss the API redesign",
        "We should use REST for the public API",
        "GraphQL might be better for internal services",
      ];
      const newMessage = "What about the API authentication?";

      const score = computeThreadSimilarity(newMessage, threadMessages);
      expect(score).toBeGreaterThan(0.01); // Some overlap expected (API keyword)
    });

    it("should return 0 for empty thread", () => {
      expect(computeThreadSimilarity("hello", [])).toBe(0);
    });

    it("should detect unrelated messages", () => {
      const threadMessages = ["The recipe calls for two cups of flour", "Add sugar and mix well"];
      const newMessage = "Deploy the Kubernetes cluster now";

      const score = computeThreadSimilarity(newMessage, threadMessages);
      expect(score).toBeLessThan(0.15);
    });
  });
});
