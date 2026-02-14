/**
 * Hephie embedding utility functions.
 *
 * Pure, dependency-free helpers for working with embedding vectors.
 */

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/**
 * Compute the cosine similarity between two vectors.
 *
 * Both vectors MUST have the same length.  If either vector is zero-length or
 * all zeros the function returns `0`.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-10) {
    return 0;
  }
  return dot / denom;
}

/**
 * L2-normalise a vector in-place (returns the same array for convenience).
 *
 * If the magnitude is effectively zero the vector is returned unchanged.
 */
export function normalizeVector(v: number[]): number[] {
  let mag = 0;
  for (let i = 0; i < v.length; i++) {
    mag += v[i] * v[i];
  }
  mag = Math.sqrt(mag);
  if (mag < 1e-10) {
    return v;
  }
  for (let i = 0; i < v.length; i++) {
    v[i] /= mag;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

/**
 * Truncate `text` so that it contains at most `maxTokens` *estimated* tokens.
 *
 * We use a cheap heuristic (split on whitespace) rather than pulling in a real
 * tokeniser — this is intentionally conservative.  The actual BPE tokeniser
 * inside the model will handle the final tokenisation; we just want to avoid
 * sending absurdly long strings.
 */
export function truncateForEmbedding(text: string, maxTokens = 512): string {
  // Fast path: short text is extremely likely to be under the limit.
  // Average English token ~4 chars; we use 3 to be conservative.
  if (text.length <= maxTokens * 3) {
    return text;
  }

  const words = text.split(/\s+/);
  if (words.length <= maxTokens) {
    return text;
  }

  return words.slice(0, maxTokens).join(" ");
}
