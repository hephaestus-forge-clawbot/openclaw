/**
 * Opus Time Horizon Predictor.
 *
 * Uses an LLM to predict the relevance lifespan of memory chunks.
 * Accepts batches of chunks, formats a prompt, parses the response,
 * and returns HorizonPredictions.
 */

import type { MemoryChunk } from "../storage/types.js";
import type { HorizonPrediction, LLMProvider } from "./types.js";
import { flattenTags } from "../tags/extractor.js";

/** Maximum chunks per batch (to keep prompt manageable). */
const MAX_BATCH_SIZE = 20;

/** Default horizon (30 days) used on error. */
const DEFAULT_HORIZON_DAYS = 30;

/**
 * The HorizonPredictor evaluates memory chunks and predicts
 * how long they will remain relevant.
 */
export class HorizonPredictor {
  constructor(private llmProvider: LLMProvider) {}

  /**
   * Predict relevance horizons for a batch of chunks.
   *
   * @param chunks - Up to 20 chunks to evaluate.
   * @returns Map from chunk.id to HorizonPrediction.
   */
  async predictBatch(chunks: MemoryChunk[]): Promise<Map<string, HorizonPrediction>> {
    if (chunks.length === 0) {
      return new Map();
    }

    // Limit batch size
    const batch = chunks.slice(0, MAX_BATCH_SIZE);
    const prompt = formatPrompt(batch);

    try {
      const response = await this.llmProvider.complete(prompt);
      return parseResponse(response, batch);
    } catch (err) {
      // On failure, return safe defaults
      console.error(
        `[hephie:horizon] Prediction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return defaultPredictions(batch);
    }
  }

  /**
   * Re-evaluate chunks that are approaching their relevance horizon.
   * Same interface as predictBatch but semantically distinct (re-evaluation
   * may include additional context in the prompt about the approaching deadline).
   */
  async reEvaluate(chunks: MemoryChunk[]): Promise<Map<string, HorizonPrediction>> {
    if (chunks.length === 0) {
      return new Map();
    }

    const batch = chunks.slice(0, MAX_BATCH_SIZE);
    const prompt = formatReEvaluationPrompt(batch);

    try {
      const response = await this.llmProvider.complete(prompt);
      return parseResponse(response, batch);
    } catch (err) {
      console.error(
        `[hephie:horizon] Re-evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return defaultPredictions(batch);
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

/**
 * Format the initial prediction prompt for a batch of chunks.
 */
export function formatPrompt(chunks: MemoryChunk[]): string {
  const now = new Date().toISOString().split("T")[0];

  let prompt = `You are evaluating memory chunks for long-term relevance.
For each chunk, predict how long it will remain useful to an AI agent.

Today's date: ${now}

Consider for each chunk:
- Is this a permanent fact (identity, core truth, policy) or a temporary situation?
- If temporal, how long will it remain relevant?
- Is this tied to an ongoing project or a completed task?
- Would the agent need this information in 1 week? 1 month? 6 months?
- Is this a policy/directive that remains until explicitly revoked?

Horizon categories:
- "ephemeral": 1-3 days (typo fixes, transient debugging notes)
- "situational": 1-4 weeks (temporary states, current issues)
- "project_scoped": 3-12 months (project facts, hypotheses, results)
- "relational": Until change detected (facts about people, roles)
- "identity": Permanent (core identity, fundamental truths)
- "policy": Until explicitly revoked (standing directives, rules)

Chunks to evaluate:
`;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tags = chunk.tags ? flattenTags(chunk.tags).join(", ") : "none";
    const created = new Date(chunk.createdAt).toISOString().split("T")[0];

    prompt += `
Chunk ${i + 1}:
  Content: ${chunk.content.slice(0, 500)}
  Tags: ${tags}
  Created: ${created}
  Tier: ${chunk.tier}
  Category: ${chunk.category ?? "unset"}
`;
  }

  prompt += `
Respond with a JSON object containing a "predictions" array. Each prediction must have:
- chunk_index: number (1-based, matching the chunk above)
- horizon: string ("permanent" or an ISO date like "2026-06-15")
- reasoning: string (one sentence explaining why)
- confidence: number (0.0 to 1.0)
- category: string (one of: ephemeral, situational, project_scoped, relational, identity, policy)

Respond ONLY with the JSON object, no other text.`;

  return prompt;
}

/**
 * Format a re-evaluation prompt for chunks approaching their horizon.
 */
export function formatReEvaluationPrompt(chunks: MemoryChunk[]): string {
  const now = new Date().toISOString().split("T")[0];

  let prompt = `You are RE-EVALUATING memory chunks whose predicted relevance horizon is approaching.
These chunks were previously predicted to become irrelevant soon. Decide whether to:
- Extend the horizon (if still relevant)
- Confirm expiry (if truly no longer useful)
- Mark as permanent (if you now see lasting value)

Today's date: ${now}

Chunks to re-evaluate:
`;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tags = chunk.tags ? flattenTags(chunk.tags).join(", ") : "none";
    const created = new Date(chunk.createdAt).toISOString().split("T")[0];
    const previousHorizon = chunk.relevanceHorizon
      ? new Date(chunk.relevanceHorizon).toISOString().split("T")[0]
      : "none";
    const previousReasoning = chunk.horizonReasoning ?? "none";

    prompt += `
Chunk ${i + 1}:
  Content: ${chunk.content.slice(0, 500)}
  Tags: ${tags}
  Created: ${created}
  Previous horizon: ${previousHorizon}
  Previous reasoning: ${previousReasoning}
  Tier: ${chunk.tier}
`;
  }

  prompt += `
Respond with a JSON object containing a "predictions" array. Each prediction must have:
- chunk_index: number (1-based)
- horizon: string ("permanent" or an ISO date)
- reasoning: string (one sentence)
- confidence: number (0.0 to 1.0)
- category: string (ephemeral, situational, project_scoped, relational, identity, policy)

Respond ONLY with the JSON object, no other text.`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface RawPrediction {
  chunk_index: number;
  horizon: string;
  reasoning: string;
  confidence: number;
  category: string;
}

/**
 * Parse an LLM response into a map of HorizonPredictions.
 */
export function parseResponse(
  response: string,
  chunks: MemoryChunk[],
): Map<string, HorizonPrediction> {
  const result = new Map<string, HorizonPrediction>();

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonStr = extractJson(response);
    const parsed = JSON.parse(jsonStr) as { predictions: RawPrediction[] };

    if (!parsed.predictions || !Array.isArray(parsed.predictions)) {
      throw new Error("Missing predictions array");
    }

    for (const pred of parsed.predictions) {
      const chunkIndex = pred.chunk_index - 1; // Convert to 0-based
      if (chunkIndex < 0 || chunkIndex >= chunks.length) {
        continue;
      }

      const chunk = chunks[chunkIndex];
      const prediction = rawToPrediction(pred);
      result.set(chunk.id, prediction);
    }
  } catch (err) {
    console.error(
      `[hephie:horizon] Failed to parse response: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Return defaults for any missing chunks
    for (const chunk of chunks) {
      if (!result.has(chunk.id)) {
        result.set(chunk.id, makeDefaultPrediction());
      }
    }
  }

  // Ensure all chunks have a prediction
  for (const chunk of chunks) {
    if (!result.has(chunk.id)) {
      result.set(chunk.id, makeDefaultPrediction());
    }
  }

  return result;
}

/**
 * Convert a raw prediction to a HorizonPrediction.
 */
function rawToPrediction(raw: RawPrediction): HorizonPrediction {
  const validCategories = [
    "ephemeral",
    "situational",
    "project_scoped",
    "relational",
    "identity",
    "policy",
  ] as const;

  const category = validCategories.includes(raw.category as (typeof validCategories)[number])
    ? (raw.category as HorizonPrediction["category"])
    : "situational";

  let horizon: Date | null = null;
  if (raw.horizon !== "permanent") {
    const parsed = new Date(raw.horizon);
    if (!isNaN(parsed.getTime())) {
      horizon = parsed;
    }
  }

  const confidence =
    typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;

  return {
    horizon,
    reasoning: raw.reasoning || "No reasoning provided.",
    confidence,
    category,
  };
}

/**
 * Extract JSON from a response that may contain markdown code blocks.
 */
function extractJson(text: string): string {
  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  return text.trim();
}

/**
 * Generate default predictions (30-day horizon) for all chunks.
 */
function defaultPredictions(chunks: MemoryChunk[]): Map<string, HorizonPrediction> {
  const result = new Map<string, HorizonPrediction>();
  for (const chunk of chunks) {
    result.set(chunk.id, makeDefaultPrediction());
  }
  return result;
}

function makeDefaultPrediction(): HorizonPrediction {
  return {
    horizon: new Date(Date.now() + DEFAULT_HORIZON_DAYS * 24 * 60 * 60 * 1000),
    reasoning: "Default 30-day horizon (prediction unavailable).",
    confidence: 0.3,
    category: "situational",
  };
}
