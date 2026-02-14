/**
 * Types for the Opus Time Horizon Predictor.
 */

import type { HorizonCategory } from "../storage/types.js";

/** Result of a horizon prediction for a single memory chunk. */
export interface HorizonPrediction {
  /** Predicted end of relevance. null = permanent. */
  horizon: Date | null;
  /** One sentence explaining the prediction. */
  reasoning: string;
  /** Confidence in the prediction (0–1). */
  confidence: number;
  /** Category of the horizon. */
  category: HorizonCategory;
}

/**
 * LLM provider interface for horizon prediction.
 *
 * Abstracts the actual model call so we can mock in tests
 * and wire in the real model routing later.
 */
export interface LLMProvider {
  /** Send a prompt and get a completion string back. */
  complete(prompt: string): Promise<string>;
}
