/**
 * Tests for the multi-dimensional tag extractor.
 */

import { describe, it, expect } from "vitest";
import type { MemoryTags } from "../storage/types.js";
import {
  extractMemoryTags,
  mergeMemoryTags,
  isEmptyTags,
  flattenTags,
  flatTagsToStructured,
} from "./extractor.js";

// ---------------------------------------------------------------------------
// extractMemoryTags
// ---------------------------------------------------------------------------

describe("extractMemoryTags — people", () => {
  it("extracts known people from content", () => {
    const tags = extractMemoryTags("Antreas told Laura about the new project");
    expect(tags.people).toContain("Antreas");
    expect(tags.people).toContain("Laura");
  });

  it("maps Father/Dad to Antreas", () => {
    const tags = extractMemoryTags("Father decided to restructure the codebase");
    expect(tags.people).toContain("Antreas");
  });

  it("extracts multiple people", () => {
    const tags = extractMemoryTags("Giannis, Andreas, and Carlos met in Cyprus");
    expect(tags.people).toContain("Giannis");
    expect(tags.people).toContain("Andreas");
    expect(tags.people).toContain("Carlos");
  });

  it("returns empty for no people", () => {
    const tags = extractMemoryTags("SQLite uses B-trees for indexing");
    expect(tags.people).toHaveLength(0);
  });
});

describe("extractMemoryTags — projects", () => {
  it("extracts known projects", () => {
    const tags = extractMemoryTags("Working on Hephie's memory system for OpenClaw");
    expect(tags.projects).toContain("Hephie");
    expect(tags.projects).toContain("OpenClaw");
  });

  it("extracts ARIA project", () => {
    const tags = extractMemoryTags("ARIA experiment results came back positive");
    expect(tags.projects).toContain("ARIA");
  });

  it("extracts hyphenated projects", () => {
    const tags = extractMemoryTags("The structure-experiments repo has new results");
    expect(tags.projects).toContain("structure-experiments");
  });

  it("extracts belonging-engine", () => {
    const tags = extractMemoryTags("The belonging-engine is a new concept");
    expect(tags.projects).toContain("belonging-engine");
  });
});

describe("extractMemoryTags — places", () => {
  it("extracts known places", () => {
    const tags = extractMemoryTags("Antreas lives in Edinburgh and is from Cyprus");
    expect(tags.places).toContain("Edinburgh");
    expect(tags.places).toContain("Cyprus");
  });

  it("extracts 'the forge'", () => {
    const tags = extractMemoryTags("Running experiments on the forge with GPU 0");
    expect(tags.places).toContain("the forge");
  });

  it("extracts MacBook", () => {
    const tags = extractMemoryTags("Set up the MacBook for development");
    expect(tags.places).toContain("MacBook");
  });
});

describe("extractMemoryTags — specialized", () => {
  it("extracts domain-specific terms", () => {
    const tags = extractMemoryTags(
      "PPA training with meta-learning on phase transitions in sqlite-vec",
    );
    expect(tags.specialized).toContain("PPA");
    expect(tags.specialized).toContain("meta-learning");
    expect(tags.specialized).toContain("phase transitions");
    expect(tags.specialized).toContain("sqlite-vec");
  });

  it("extracts ML/AI terminology", () => {
    const tags = extractMemoryTags("Fine-tuning the transformer with LoRA on GPU");
    expect(tags.specialized).toContain("fine-tuning");
    expect(tags.specialized).toContain("transformers");
    expect(tags.specialized).toContain("LoRA");
    expect(tags.specialized).toContain("GPU");
  });

  it("extracts LLM and RAG", () => {
    const tags = extractMemoryTags("Building a RAG pipeline with LLM embeddings");
    expect(tags.specialized).toContain("RAG");
    expect(tags.specialized).toContain("LLM");
    expect(tags.specialized).toContain("embeddings");
  });
});

describe("extractMemoryTags — concepts", () => {
  it("extracts general concepts", () => {
    const tags = extractMemoryTags("Machine learning infrastructure for deployment and testing");
    expect(tags.concepts).toContain("machine learning");
    expect(tags.concepts).toContain("infrastructure");
    expect(tags.concepts).toContain("deployment");
    expect(tags.concepts).toContain("testing");
  });

  it("extracts research and experimentation", () => {
    const tags = extractMemoryTags("Running research experiments on database migration");
    expect(tags.concepts).toContain("research");
    expect(tags.concepts).toContain("experimentation");
    expect(tags.concepts).toContain("database");
    expect(tags.concepts).toContain("migration");
  });
});

describe("extractMemoryTags — context path", () => {
  it("extracts tags from context path as well", () => {
    const tags = extractMemoryTags("Some content about coding", "## Hephie > ### ARIA Integration");
    expect(tags.projects).toContain("Hephie");
    expect(tags.projects).toContain("ARIA");
  });
});

describe("extractMemoryTags — mixed content", () => {
  it("extracts across all dimensions from rich content", () => {
    const content =
      "Father and Laura discussed the ARIA project at Edinburgh. " +
      "They're using meta-learning with transformers for machine learning research. " +
      "Experiments are running on the forge with GPU acceleration.";

    const tags = extractMemoryTags(content);

    expect(tags.people).toContain("Antreas");
    expect(tags.people).toContain("Laura");
    expect(tags.projects).toContain("ARIA");
    expect(tags.places).toContain("Edinburgh");
    expect(tags.places).toContain("the forge");
    expect(tags.specialized).toContain("meta-learning");
    expect(tags.specialized).toContain("transformers");
    expect(tags.specialized).toContain("GPU");
    expect(tags.concepts).toContain("machine learning");
    expect(tags.concepts).toContain("research");
  });

  it("deduplicates within dimensions", () => {
    const tags = extractMemoryTags("Father said, Father also mentioned, Father concluded");
    // Should only have one "Antreas"
    expect(tags.people.filter((p) => p === "Antreas")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mergeMemoryTags
// ---------------------------------------------------------------------------

describe("mergeMemoryTags", () => {
  it("merges two tag objects with deduplication", () => {
    const a: MemoryTags = {
      concepts: ["machine learning", "testing"],
      specialized: ["PPA"],
      people: ["Antreas"],
      places: ["Edinburgh"],
      projects: ["Hephie"],
    };
    const b: MemoryTags = {
      concepts: ["testing", "deployment"],
      specialized: ["meta-learning"],
      people: ["Antreas", "Laura"],
      places: ["Cyprus"],
      projects: ["ARIA"],
    };

    const merged = mergeMemoryTags(a, b);

    expect(merged.concepts).toEqual(["machine learning", "testing", "deployment"]);
    expect(merged.specialized).toEqual(["PPA", "meta-learning"]);
    expect(merged.people).toEqual(["Antreas", "Laura"]);
    expect(merged.places).toEqual(["Edinburgh", "Cyprus"]);
    expect(merged.projects).toEqual(["Hephie", "ARIA"]);
  });
});

// ---------------------------------------------------------------------------
// isEmptyTags
// ---------------------------------------------------------------------------

describe("isEmptyTags", () => {
  it("returns true for empty tags", () => {
    expect(
      isEmptyTags({ concepts: [], specialized: [], people: [], places: [], projects: [] }),
    ).toBe(true);
  });

  it("returns false when any dimension has tags", () => {
    expect(
      isEmptyTags({
        concepts: ["test"],
        specialized: [],
        people: [],
        places: [],
        projects: [],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// flattenTags
// ---------------------------------------------------------------------------

describe("flattenTags", () => {
  it("flattens all dimensions into a single array", () => {
    const tags: MemoryTags = {
      concepts: ["machine learning"],
      specialized: ["PPA"],
      people: ["Antreas"],
      places: ["Edinburgh"],
      projects: ["Hephie"],
    };

    const flat = flattenTags(tags);
    expect(flat).toContain("machine learning");
    expect(flat).toContain("PPA");
    expect(flat).toContain("Antreas");
    expect(flat).toContain("Edinburgh");
    expect(flat).toContain("Hephie");
    expect(flat).toHaveLength(5);
  });

  it("deduplicates across dimensions", () => {
    const tags: MemoryTags = {
      concepts: ["memory"],
      specialized: ["memory"],
      people: [],
      places: [],
      projects: [],
    };

    const flat = flattenTags(tags);
    expect(flat.filter((t) => t === "memory")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// flatTagsToStructured
// ---------------------------------------------------------------------------

describe("flatTagsToStructured", () => {
  it("converts flat tags to structured format", () => {
    const flat = ["forge", "aria", "antreas", "PPA", "machine learning", "edinburgh"];
    const structured = flatTagsToStructured(flat);

    expect(structured.places).toContain("the forge");
    expect(structured.projects).toContain("ARIA");
    expect(structured.people).toContain("Antreas");
    expect(structured.specialized).toContain("PPA");
    expect(structured.concepts).toContain("machine learning");
    expect(structured.places).toContain("Edinburgh");
  });

  it("puts unknown tags in concepts", () => {
    const flat = ["random-tag", "another-thing"];
    const structured = flatTagsToStructured(flat);

    expect(structured.concepts).toContain("random-tag");
    expect(structured.concepts).toContain("another-thing");
  });

  it("handles empty input", () => {
    const structured = flatTagsToStructured([]);
    expect(isEmptyTags(structured)).toBe(true);
  });
});
