/**
 * Tests for the Opus Time Horizon Predictor.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { MemoryChunk } from "../storage/types.js";
import { MockLLMProvider } from "./mock-llm-provider.js";
import {
  HorizonPredictor,
  formatPrompt,
  formatReEvaluationPrompt,
  parseResponse,
} from "./predictor.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id: overrides.id ?? `chunk-${Math.random().toString(36).slice(2, 8)}`,
    tier: "short_term",
    content: "Test chunk content about some topic",
    confidence: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatPrompt
// ---------------------------------------------------------------------------

describe("formatPrompt", () => {
  it("includes all chunks in the prompt", () => {
    const chunks = [
      makeChunk({ content: "Alpha content" }),
      makeChunk({ content: "Beta content" }),
      makeChunk({ content: "Gamma content" }),
    ];

    const prompt = formatPrompt(chunks);

    expect(prompt).toContain("Alpha content");
    expect(prompt).toContain("Beta content");
    expect(prompt).toContain("Gamma content");
    expect(prompt).toContain("Chunk 1:");
    expect(prompt).toContain("Chunk 2:");
    expect(prompt).toContain("Chunk 3:");
  });

  it("includes today's date", () => {
    const today = new Date().toISOString().split("T")[0];
    const prompt = formatPrompt([makeChunk()]);
    expect(prompt).toContain(today);
  });

  it("includes tag information", () => {
    const chunk = makeChunk({
      tags: {
        concepts: ["testing"],
        specialized: ["PPA"],
        people: ["Antreas"],
        places: ["Edinburgh"],
        projects: ["Hephie"],
      },
    });
    const prompt = formatPrompt([chunk]);

    expect(prompt).toContain("testing");
    expect(prompt).toContain("PPA");
    expect(prompt).toContain("Antreas");
    expect(prompt).toContain("Edinburgh");
    expect(prompt).toContain("Hephie");
  });

  it("includes chunk metadata (tier, category, created date)", () => {
    const chunk = makeChunk({
      tier: "long_term",
      category: "decision",
      createdAt: new Date("2026-01-15").getTime(),
    });
    const prompt = formatPrompt([chunk]);

    expect(prompt).toContain("long_term");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("2026-01-15");
  });

  it("includes horizon category descriptions", () => {
    const prompt = formatPrompt([makeChunk()]);

    expect(prompt).toContain("ephemeral");
    expect(prompt).toContain("situational");
    expect(prompt).toContain("project_scoped");
    expect(prompt).toContain("relational");
    expect(prompt).toContain("identity");
    expect(prompt).toContain("policy");
  });

  it("truncates very long content", () => {
    const longContent = "A".repeat(1000);
    const prompt = formatPrompt([makeChunk({ content: longContent })]);

    // Content should be truncated to 500 chars
    expect(prompt).not.toContain("A".repeat(1000));
    expect(prompt).toContain("A".repeat(500));
  });
});

// ---------------------------------------------------------------------------
// formatReEvaluationPrompt
// ---------------------------------------------------------------------------

describe("formatReEvaluationPrompt", () => {
  it("includes previous horizon information", () => {
    const chunk = makeChunk({
      relevanceHorizon: new Date("2026-03-15").getTime(),
      horizonReasoning: "Project may wrap up by mid-March.",
    });

    const prompt = formatReEvaluationPrompt([chunk]);

    expect(prompt).toContain("2026-03-15");
    expect(prompt).toContain("Project may wrap up by mid-March.");
    expect(prompt).toContain("RE-EVALUATING");
  });

  it("handles chunks without previous horizon", () => {
    const chunk = makeChunk();
    const prompt = formatReEvaluationPrompt([chunk]);

    expect(prompt).toContain("Previous horizon: none");
    expect(prompt).toContain("Previous reasoning: none");
  });
});

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

describe("parseResponse", () => {
  it("parses valid JSON response", () => {
    const chunks = [makeChunk({ id: "c1" }), makeChunk({ id: "c2" })];
    const response = JSON.stringify({
      predictions: [
        {
          chunk_index: 1,
          horizon: "2026-06-15",
          reasoning: "Project-scoped, relevant for months.",
          confidence: 0.85,
          category: "project_scoped",
        },
        {
          chunk_index: 2,
          horizon: "permanent",
          reasoning: "Core identity fact.",
          confidence: 0.95,
          category: "identity",
        },
      ],
    });

    const result = parseResponse(response, chunks);

    expect(result.size).toBe(2);

    const p1 = result.get("c1")!;
    expect(p1.horizon).toBeInstanceOf(Date);
    expect(p1.horizon!.getFullYear()).toBe(2026);
    expect(p1.reasoning).toBe("Project-scoped, relevant for months.");
    expect(p1.confidence).toBe(0.85);
    expect(p1.category).toBe("project_scoped");

    const p2 = result.get("c2")!;
    expect(p2.horizon).toBeNull(); // permanent
    expect(p2.category).toBe("identity");
  });

  it("parses JSON wrapped in code blocks", () => {
    const chunks = [makeChunk({ id: "c1" })];
    const response = `\`\`\`json
{
  "predictions": [{
    "chunk_index": 1,
    "horizon": "permanent",
    "reasoning": "Identity chunk.",
    "confidence": 0.9,
    "category": "identity"
  }]
}
\`\`\``;

    const result = parseResponse(response, chunks);
    expect(result.get("c1")!.category).toBe("identity");
  });

  it("returns defaults for malformed response", () => {
    const chunks = [makeChunk({ id: "c1" }), makeChunk({ id: "c2" })];
    const result = parseResponse("not valid json at all", chunks);

    expect(result.size).toBe(2);
    // Default is 30-day horizon, situational
    const p1 = result.get("c1")!;
    expect(p1.category).toBe("situational");
    expect(p1.confidence).toBe(0.3);
    expect(p1.horizon).toBeInstanceOf(Date);
  });

  it("clamps confidence to 0-1 range", () => {
    const chunks = [makeChunk({ id: "c1" })];
    const response = JSON.stringify({
      predictions: [
        {
          chunk_index: 1,
          horizon: "permanent",
          reasoning: "test",
          confidence: 1.5, // out of range
          category: "identity",
        },
      ],
    });

    const result = parseResponse(response, chunks);
    expect(result.get("c1")!.confidence).toBe(1.0);
  });

  it("handles missing predictions for some chunks", () => {
    const chunks = [makeChunk({ id: "c1" }), makeChunk({ id: "c2" })];
    const response = JSON.stringify({
      predictions: [
        {
          chunk_index: 1,
          horizon: "permanent",
          reasoning: "test",
          confidence: 0.9,
          category: "identity",
        },
        // chunk_index 2 is missing
      ],
    });

    const result = parseResponse(response, chunks);
    expect(result.size).toBe(2);
    // c2 should get default prediction
    expect(result.get("c2")!.category).toBe("situational");
    expect(result.get("c2")!.confidence).toBe(0.3);
  });

  it("handles invalid category by defaulting to situational", () => {
    const chunks = [makeChunk({ id: "c1" })];
    const response = JSON.stringify({
      predictions: [
        {
          chunk_index: 1,
          horizon: "permanent",
          reasoning: "test",
          confidence: 0.8,
          category: "invalid_category",
        },
      ],
    });

    const result = parseResponse(response, chunks);
    expect(result.get("c1")!.category).toBe("situational");
  });
});

// ---------------------------------------------------------------------------
// HorizonPredictor.predictBatch
// ---------------------------------------------------------------------------

describe("HorizonPredictor — predictBatch", () => {
  let provider: MockLLMProvider;
  let predictor: HorizonPredictor;

  beforeEach(() => {
    provider = new MockLLMProvider();
    predictor = new HorizonPredictor(provider);
  });

  it("sends prompt to LLM and returns predictions", async () => {
    const chunks = [
      makeChunk({ id: "c1", content: "Father's name is Antreas" }),
      makeChunk({ id: "c2", content: "Fixed a typo in config.json" }),
    ];

    const results = await predictor.predictBatch(chunks);

    expect(results.size).toBe(2);
    expect(results.has("c1")).toBe(true);
    expect(results.has("c2")).toBe(true);
    // Prompt was sent to the provider
    expect(provider.prompts.length).toBe(1);
    expect(provider.prompts[0]).toContain("Father's name is Antreas");
  });

  it("returns empty map for empty input", async () => {
    const results = await predictor.predictBatch([]);
    expect(results.size).toBe(0);
    expect(provider.prompts.length).toBe(0);
  });

  it("limits batch size to 20", async () => {
    const chunks = Array.from({ length: 25 }, (_, i) =>
      makeChunk({ id: `c${i}`, content: `Chunk content ${i}` }),
    );

    const results = await predictor.predictBatch(chunks);

    // Should only process first 20
    expect(results.size).toBe(20);
    expect(results.has("c0")).toBe(true);
    expect(results.has("c19")).toBe(true);
    expect(results.has("c20")).toBe(false);
  });

  it("handles LLM failure gracefully with defaults", async () => {
    provider.setFailure(true);

    const chunks = [makeChunk({ id: "c1" }), makeChunk({ id: "c2" })];
    const results = await predictor.predictBatch(chunks);

    expect(results.size).toBe(2);
    // All should be default 30-day horizons
    for (const pred of results.values()) {
      expect(pred.category).toBe("situational");
      expect(pred.confidence).toBe(0.3);
      expect(pred.horizon).toBeInstanceOf(Date);
    }
  });

  it("parses custom LLM response correctly", async () => {
    const chunks = [makeChunk({ id: "c1", content: "I am Hephaestus" })];

    provider.setResponse(
      JSON.stringify({
        predictions: [
          {
            chunk_index: 1,
            horizon: "permanent",
            reasoning: "Core identity statement.",
            confidence: 0.99,
            category: "identity",
          },
        ],
      }),
    );

    const results = await predictor.predictBatch(chunks);
    const pred = results.get("c1")!;

    expect(pred.horizon).toBeNull();
    expect(pred.category).toBe("identity");
    expect(pred.confidence).toBe(0.99);
    expect(pred.reasoning).toBe("Core identity statement.");
  });
});

// ---------------------------------------------------------------------------
// HorizonPredictor.reEvaluate
// ---------------------------------------------------------------------------

describe("HorizonPredictor — reEvaluate", () => {
  let provider: MockLLMProvider;
  let predictor: HorizonPredictor;

  beforeEach(() => {
    provider = new MockLLMProvider();
    predictor = new HorizonPredictor(provider);
  });

  it("sends re-evaluation prompt", async () => {
    const chunks = [
      makeChunk({
        id: "c1",
        content: "Forge is down for thermal issues",
        relevanceHorizon: Date.now() + 1000,
        horizonReasoning: "Should resolve in a week.",
      }),
    ];

    const results = await predictor.reEvaluate(chunks);

    expect(results.size).toBe(1);
    expect(provider.prompts.length).toBe(1);
    expect(provider.prompts[0]).toContain("RE-EVALUATING");
    expect(provider.prompts[0]).toContain("Previous horizon");
  });

  it("handles empty input", async () => {
    const results = await predictor.reEvaluate([]);
    expect(results.size).toBe(0);
  });

  it("handles failure gracefully", async () => {
    provider.setFailure(true);

    const results = await predictor.reEvaluate([makeChunk({ id: "c1" })]);
    expect(results.size).toBe(1);
    expect(results.get("c1")!.confidence).toBe(0.3); // default
  });
});

// ---------------------------------------------------------------------------
// MockLLMProvider
// ---------------------------------------------------------------------------

describe("MockLLMProvider", () => {
  it("records prompts", async () => {
    const provider = new MockLLMProvider();
    await provider.complete("prompt 1");
    await provider.complete("prompt 2");

    expect(provider.prompts).toEqual(["prompt 1", "prompt 2"]);
  });

  it("returns custom response", async () => {
    const provider = new MockLLMProvider();
    provider.setResponse("custom response");

    const result = await provider.complete("test");
    expect(result).toBe("custom response");

    // After consuming, should return default
    const result2 = await provider.complete("test2");
    expect(result2).not.toBe("custom response");
  });

  it("throws on failure", async () => {
    const provider = new MockLLMProvider();
    provider.setFailure(true);

    await expect(provider.complete("test")).rejects.toThrow("Mock LLM failure");
  });
});
