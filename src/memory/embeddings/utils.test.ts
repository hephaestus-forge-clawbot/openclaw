import { describe, expect, it } from "vitest";
import { cosineSimilarity, normalizeVector, truncateForEmbedding } from "./utils.js";

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1 for identical unit vectors", () => {
    const v = normalizeVector([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("is symmetric", () => {
    const a = [1, 2, 3, 4];
    const b = [5, 6, 7, 8];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it("handles high-dimensional vectors", () => {
    const dim = 384;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.cos(i));
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(-1);
    expect(sim).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeVector
// ---------------------------------------------------------------------------

describe("normalizeVector", () => {
  it("produces unit length", () => {
    const v = normalizeVector([3, 4]);
    const mag = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    expect(mag).toBeCloseTo(1.0, 10);
  });

  it("preserves direction", () => {
    const v = normalizeVector([3, 4]);
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
  });

  it("handles zero vector gracefully", () => {
    const v = normalizeVector([0, 0, 0]);
    expect(v).toEqual([0, 0, 0]);
  });

  it("handles already-normalised vector", () => {
    const v = normalizeVector([1, 0, 0]);
    expect(v).toEqual([1, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// truncateForEmbedding
// ---------------------------------------------------------------------------

describe("truncateForEmbedding", () => {
  it("returns short text unchanged", () => {
    expect(truncateForEmbedding("hello world", 512)).toBe("hello world");
  });

  it("truncates long text to maxTokens words", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const result = truncateForEmbedding(text, 100);
    expect(result.split(/\s+/).length).toBe(100);
  });

  it("defaults to 512 tokens", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}`);
    const text = words.join(" ");
    const result = truncateForEmbedding(text);
    expect(result.split(/\s+/).length).toBe(512);
  });

  it("handles empty string", () => {
    expect(truncateForEmbedding("")).toBe("");
  });

  it("handles text with multiple whitespace", () => {
    const result = truncateForEmbedding("  hello   world  ", 512);
    // split on whitespace may produce empty strings at edges — result should be valid
    expect(result.length).toBeGreaterThan(0);
  });
});
