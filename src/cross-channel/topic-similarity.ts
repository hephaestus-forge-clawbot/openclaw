/**
 * Topic Similarity Engine (Hephie Phase 3.3)
 *
 * Determines if two messages or message groups are about the same topic.
 * Uses keyword/entity overlap with TF-IDF-inspired weighting.
 * No external dependencies — pure text analysis.
 */

// ── Stop Words ──────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "up",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "can",
  "will",
  "just",
  "should",
  "now",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "do",
  "does",
  "did",
  "doing",
  "would",
  "could",
  "might",
  "must",
  "shall",
  "may",
  "i",
  "me",
  "my",
  "myself",
  "we",
  "our",
  "ours",
  "ourselves",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "he",
  "him",
  "his",
  "himself",
  "she",
  "her",
  "hers",
  "herself",
  "it",
  "its",
  "itself",
  "they",
  "them",
  "their",
  "theirs",
  "themselves",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "am",
  "if",
  "as",
  "because",
  "until",
  "while",
  // Common chat filler
  "ok",
  "okay",
  "yes",
  "yeah",
  "no",
  "nah",
  "hey",
  "hi",
  "hello",
  "thanks",
  "thank",
  "please",
  "sure",
  "right",
  "well",
  "like",
  "get",
  "got",
  "let",
  "go",
  "going",
  "know",
  "think",
  "want",
  "need",
  "see",
  "look",
  "make",
  "take",
  "come",
  "give",
  "tell",
  "said",
  "say",
  "also",
  "still",
  "already",
  "even",
  "much",
  "thing",
  "things",
  "stuff",
  "way",
  "really",
  "actually",
]);

// ── Tokenization ────────────────────────────────────────────────────────

/**
 * Extract meaningful tokens from text.
 * Removes stop words, normalizes case, extracts entities.
 */
export function extractTokens(text: string): string[] {
  if (!text) {
    return [];
  }

  // Normalize
  const normalized = text.toLowerCase();

  // Extract words (including hyphenated terms and code-like identifiers)
  const rawTokens = normalized.match(/[a-z][a-z0-9_-]*[a-z0-9]|[a-z0-9]{2,}/g) ?? [];

  // Filter stop words and very short tokens
  return rawTokens.filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Extract key entities from text — URLs, file paths, code identifiers,
 * numbers with units, etc. These are high-signal tokens.
 */
export function extractEntities(text: string): string[] {
  const entities: string[] = [];

  // URLs
  const urls = text.match(/https?:\/\/[^\s<>]+/gi);
  if (urls) {
    for (const url of urls) {
      // Extract domain as entity
      const domain = url.match(/\/\/([^/]+)/)?.[1];
      if (domain) {
        entities.push(domain.toLowerCase());
      }
    }
  }

  // File paths
  const paths = text.match(/(?:\/[\w.-]+)+\.\w+/g);
  if (paths) {
    for (const p of paths) {
      const filename = p.split("/").pop();
      if (filename) {
        entities.push(filename.toLowerCase());
      }
    }
  }

  // Mentions (@username)
  const mentions = text.match(/@[\w.-]+/g);
  if (mentions) {
    entities.push(...mentions.map((m) => m.toLowerCase()));
  }

  // Hashtags (#topic)
  const hashtags = text.match(/#[\w-]+/g);
  if (hashtags) {
    entities.push(...hashtags.map((h) => h.toLowerCase()));
  }

  // Code identifiers (camelCase, PascalCase, snake_case — 3+ chars)
  const codeIdents = text.match(/[A-Z][a-z]+[A-Z][a-zA-Z]*|[a-z]+_[a-z_]+/g);
  if (codeIdents) {
    entities.push(...codeIdents.map((c) => c.toLowerCase()));
  }

  return [...new Set(entities)];
}

// ── Similarity Scoring ──────────────────────────────────────────────────

/**
 * Compute token overlap similarity between two token sets.
 * Uses Jaccard similarity with IDF-like weighting for rare terms.
 *
 * @returns Score between 0 (no similarity) and 1 (identical topics).
 */
export function computeTokenSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  // Compute intersection
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }

  if (intersection === 0) {
    return 0;
  }

  // Jaccard similarity: |A ∩ B| / |A ∪ B|
  const union = setA.size + setB.size - intersection;
  const jaccard = intersection / union;

  // Boost: if more than half of the smaller set matches, strong signal
  const minSize = Math.min(setA.size, setB.size);
  const overlapRatio = intersection / minSize;
  const boost = overlapRatio > 0.5 ? 1.0 + (overlapRatio - 0.5) : 1.0;

  return Math.min(jaccard * boost, 1.0);
}

/**
 * Compute n-gram overlap for capturing phrase-level similarity.
 * Bigrams catch "machine learning" vs "deep learning" cases.
 */
export function computeBigramSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length < 2 || tokensB.length < 2) {
    return 0;
  }

  const bigramsA = new Set<string>();
  for (let i = 0; i < tokensA.length - 1; i++) {
    bigramsA.add(`${tokensA[i]} ${tokensA[i + 1]}`);
  }

  const bigramsB = new Set<string>();
  for (let i = 0; i < tokensB.length - 1; i++) {
    bigramsB.add(`${tokensB[i]} ${tokensB[i + 1]}`);
  }

  let intersection = 0;
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) {
      intersection++;
    }
  }

  if (intersection === 0) {
    return 0;
  }

  const union = bigramsA.size + bigramsB.size - intersection;
  return intersection / union;
}

/**
 * Compute overall topic similarity between two text passages.
 *
 * Combines:
 * - Token overlap (weighted 0.4)
 * - Entity overlap (weighted 0.35)
 * - Bigram overlap (weighted 0.25)
 *
 * @returns Score between 0 and 1.
 */
export function computeTopicSimilarity(textA: string, textB: string): number {
  const tokensA = extractTokens(textA);
  const tokensB = extractTokens(textB);
  const entitiesA = extractEntities(textA);
  const entitiesB = extractEntities(textB);

  const tokenSim = computeTokenSimilarity(tokensA, tokensB);
  const entitySim = computeTokenSimilarity(entitiesA, entitiesB);
  const bigramSim = computeBigramSimilarity(tokensA, tokensB);

  // Weighted combination
  const w_token = 0.4;
  const w_entity = 0.35;
  const w_bigram = 0.25;

  // Only use entity similarity if both texts have entities
  if (entitiesA.length > 0 && entitiesB.length > 0) {
    return w_token * tokenSim + w_entity * entitySim + w_bigram * bigramSim;
  }

  // Fall back to token + bigram only
  const adjustedTokenWeight = w_token + w_entity * 0.7;
  const adjustedBigramWeight = w_bigram + w_entity * 0.3;
  return adjustedTokenWeight * tokenSim + adjustedBigramWeight * bigramSim;
}

/**
 * Compute topic similarity between a single message and a set of messages
 * (e.g., all messages in an existing thread). Uses the aggregate of
 * all thread messages as the comparison corpus.
 *
 * @returns Score between 0 and 1.
 */
export function computeThreadSimilarity(messageText: string, threadMessages: string[]): number {
  if (threadMessages.length === 0) {
    return 0;
  }

  // Concatenate thread messages into a single corpus
  const threadCorpus = threadMessages.join(" ");
  return computeTopicSimilarity(messageText, threadCorpus);
}
