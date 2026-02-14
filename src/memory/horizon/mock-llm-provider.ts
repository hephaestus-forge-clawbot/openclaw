/**
 * Mock LLM provider for testing the horizon predictor.
 *
 * Returns pre-configured responses or generates sensible defaults
 * based on the input prompt.
 */

import type { LLMProvider } from "./types.js";

/**
 * A mock LLM provider that returns deterministic responses
 * for testing horizon prediction.
 */
export class MockLLMProvider implements LLMProvider {
  /** Recorded prompts for test inspection. */
  readonly prompts: string[] = [];

  /** Pre-configured response to return. If null, generates a default. */
  private response: string | null = null;

  /** Whether to simulate a failure. */
  private shouldFail = false;

  /**
   * Set a fixed response for the next call.
   */
  setResponse(response: string): void {
    this.response = response;
  }

  /**
   * Set the provider to fail on the next call.
   */
  setFailure(fail: boolean): void {
    this.shouldFail = fail;
  }

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);

    if (this.shouldFail) {
      throw new Error("Mock LLM failure");
    }

    if (this.response !== null) {
      const r = this.response;
      this.response = null; // consume the response
      return r;
    }

    // Default: return a reasonable JSON response based on chunk count
    return this.generateDefaultResponse(prompt);
  }

  private generateDefaultResponse(prompt: string): string {
    // Count how many chunks are in the prompt by looking for "Chunk X:" patterns
    const chunkMatches = prompt.match(/Chunk \d+:/g);
    const count = chunkMatches?.length ?? 1;

    const predictions = [];
    for (let i = 1; i <= count; i++) {
      // Alternate between categories for variety in tests
      const categories = [
        "ephemeral",
        "situational",
        "project_scoped",
        "relational",
        "identity",
        "policy",
      ] as const;
      const category = categories[(i - 1) % categories.length];

      let horizon: string;
      if (category === "identity" || category === "policy") {
        horizon = "permanent";
      } else if (category === "ephemeral") {
        const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
        horizon = d.toISOString().split("T")[0];
      } else {
        const d = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        horizon = d.toISOString().split("T")[0];
      }

      predictions.push({
        chunk_index: i,
        horizon,
        reasoning: `Mock prediction for chunk ${i}: categorized as ${category}.`,
        confidence: 0.8,
        category,
      });
    }

    return JSON.stringify({ predictions });
  }
}
