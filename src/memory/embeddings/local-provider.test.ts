import { describe, expect, it } from "vitest";
import { LocalEmbeddingProvider } from "./local-provider.js";
import { cosineSimilarity } from "./utils.js";

// These tests perform real model inference.  The first run downloads the model
// (~80 MB) which can take a while.  The vitest config sets a generous timeout
// so this should be fine in CI and locally.

const LONG_TIMEOUT = 120_000;

describe("LocalEmbeddingProvider", () => {
  // Shared instance — the model is loaded once and reused across tests.
  const provider = new LocalEmbeddingProvider();

  // ------------------------------------------------------------------
  // Basic embedding
  // ------------------------------------------------------------------

  it("reports correct modelId and dimensions", () => {
    expect(provider.modelId).toBe("sentence-transformers/all-MiniLM-L6-v2");
    expect(provider.dimensions).toBe(384);
  });

  it("produces a 384-dimensional embedding", { timeout: LONG_TIMEOUT }, async () => {
    const vec = await provider.embed("hello world");
    expect(vec).toHaveLength(384);
    // Every element should be a finite number
    for (const v of vec) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("returns normalised vectors (unit length)", { timeout: LONG_TIMEOUT }, async () => {
    const vec = await provider.embed("test normalisation");
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(mag).toBeCloseTo(1.0, 3);
  });

  // ------------------------------------------------------------------
  // Semantic similarity
  // ------------------------------------------------------------------

  it("identical texts have cosine similarity ≈ 1.0", { timeout: LONG_TIMEOUT }, async () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const a = await provider.embed(text);
    const b = await provider.embed(text);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 3);
  });

  it(
    "similar texts have higher similarity than dissimilar texts",
    { timeout: LONG_TIMEOUT },
    async () => {
      const [catVec, kittenVec, rocketVec] = await provider.embedBatch([
        "I love cats",
        "I adore kittens",
        "Quantum mechanics describes subatomic particles",
      ]);
      const simCatKitten = cosineSimilarity(catVec, kittenVec);
      const simCatRocket = cosineSimilarity(catVec, rocketVec);
      expect(simCatKitten).toBeGreaterThan(simCatRocket);
    },
  );

  // ------------------------------------------------------------------
  // Batch embedding
  // ------------------------------------------------------------------

  it("embedBatch returns one vector per input", { timeout: LONG_TIMEOUT }, async () => {
    const texts = ["hello", "world", "foo bar baz"];
    const vecs = await provider.embedBatch(texts);
    expect(vecs).toHaveLength(texts.length);
    for (const vec of vecs) {
      expect(vec).toHaveLength(384);
    }
  });

  it("embedBatch results match individual embed calls", { timeout: LONG_TIMEOUT }, async () => {
    const texts = ["alpha", "beta"];
    const batch = await provider.embedBatch(texts);
    const individual = await Promise.all(texts.map((t) => provider.embed(t)));

    for (let i = 0; i < texts.length; i++) {
      const sim = cosineSimilarity(batch[i], individual[i]);
      // Should be identical (or extremely close due to float precision)
      expect(sim).toBeCloseTo(1.0, 3);
    }
  });

  // ------------------------------------------------------------------
  // Long text handling
  // ------------------------------------------------------------------

  it("handles very long text without error", { timeout: LONG_TIMEOUT }, async () => {
    const longText = "word ".repeat(2000);
    const vec = await provider.embed(longText);
    expect(vec).toHaveLength(384);
  });

  // ------------------------------------------------------------------
  // Availability
  // ------------------------------------------------------------------

  it("isAvailable returns true", { timeout: LONG_TIMEOUT }, async () => {
    expect(await provider.isAvailable()).toBe(true);
  });
});
