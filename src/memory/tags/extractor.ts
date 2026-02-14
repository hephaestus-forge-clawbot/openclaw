/**
 * Multi-dimensional tag extractor for Hephie's memory system.
 *
 * Extracts structured tags (concepts, specialized, people, places, projects)
 * from memory chunk content using entity recognition patterns and known
 * entity lists.
 */

import type { MemoryTags } from "../storage/types.js";

// ---------------------------------------------------------------------------
// Known entity lists (expandable over time)
// ---------------------------------------------------------------------------

/** People: [pattern, canonical name] — pattern is case-insensitive. */
const KNOWN_PEOPLE: Array<[RegExp, string]> = [
  [/\b(?:antreas|father|dad)\b/i, "Antreas"],
  [/\blaura\b/i, "Laura"],
  [/\bgiannis\b/i, "Giannis"],
  [/\bandreas\b/i, "Andreas"],
  [/\bcarlos\b/i, "Carlos"],
  [/\bfady\b/i, "Fady"],
  [/\bthomas\b/i, "Thomas"],
  [/\bpaul\b/i, "Paul"],
  [/\baris\b/i, "Aris"],
  [/\bpasquale\b/i, "Pasquale"],
  [/\bdante\b/i, "Dante"],
];

/** Projects: [pattern, canonical name]. */
const KNOWN_PROJECTS: Array<[RegExp, string]> = [
  [/\bhephie\b/i, "Hephie"],
  [/\bopenclaw\b/i, "OpenClaw"],
  [/\bstructure[- ]?experiments\b/i, "structure-experiments"],
  [/\baria\b/i, "ARIA"],
  [/\baxiotic\b/i, "Axiotic"],
  [/\bbelonging[- ]?engine\b/i, "belonging-engine"],
  [/\bagent[- ]?commons\b/i, "agent-commons"],
  [/\bmoltbo(?:ok|t)\b/i, "Moltbook"],
];

/** Places: [pattern, canonical name]. */
const KNOWN_PLACES: Array<[RegExp, string]> = [
  [/\bedinburgh\b/i, "Edinburgh"],
  [/\bcyprus\b/i, "Cyprus"],
  [/\bthe forge\b/i, "the forge"],
  [/\bforge\b(?!\s*(?:d|s\b))/i, "the forge"], // "forge" but not "forged" or "forges"
  [/\bmacbook\b/i, "MacBook"],
  [/\blondon\b/i, "London"],
  [/\bathens\b/i, "Athens"],
  [/\bnicosia\b/i, "Nicosia"],
];

/** Specialized domain terms: [pattern, canonical name]. */
const KNOWN_SPECIALIZED: Array<[RegExp, string]> = [
  [/\bPPA\b/, "PPA"],
  [/\bmeta[- ]?learning\b/i, "meta-learning"],
  [/\bphase[- ]?transitions?\b/i, "phase transitions"],
  [/\bsqlite[- ]?vec\b/i, "sqlite-vec"],
  [/\btransformers?\b/i, "transformers"],
  [/\bembeddings?\b/i, "embeddings"],
  [/\bvector[- ]?search\b/i, "vector search"],
  [/\bfine[- ]?tun(?:e|ing)\b/i, "fine-tuning"],
  [/\breinforcement[- ]?learning\b/i, "reinforcement learning"],
  [/\bneural[- ]?(?:net(?:work)?s?|architecture)\b/i, "neural networks"],
  [/\bFTS5?\b/, "FTS"],
  [/\bRAG\b/, "RAG"],
  [/\bGPU\b/i, "GPU"],
  [/\bCUDA\b/i, "CUDA"],
  [/\bLLM\b/, "LLM"],
  [/\bLo[Rr]A\b/, "LoRA"],
  [/\bMLOps\b/i, "MLOps"],
  [/\bCI\/CD\b/i, "CI/CD"],
  [/\bkubernetes\b/i, "Kubernetes"],
  [/\bdocker\b/i, "Docker"],
];

/** General concept patterns: [pattern, canonical name]. */
const CONCEPT_PATTERNS: Array<[RegExp, string]> = [
  [/\bmachine[- ]?learning\b/i, "machine learning"],
  [/\bdeep[- ]?learning\b/i, "deep learning"],
  [/\binfrastructure\b/i, "infrastructure"],
  [/\bdebugging\b/i, "debugging"],
  [/\barchitecture\b/i, "architecture"],
  [/\btesting\b/i, "testing"],
  [/\bdeployment\b/i, "deployment"],
  [/\bperformance\b/i, "performance"],
  [/\bsecurity\b/i, "security"],
  [/\bautomation\b/i, "automation"],
  [/\boptimization\b/i, "optimization"],
  [/\bdata[- ]?pipeline\b/i, "data pipeline"],
  [/\bAPI\b/, "API"],
  [/\bdatabase\b/i, "database"],
  [/\bmigration\b/i, "migration"],
  [/\bidentity\b/i, "identity"],
  [/\bmemory\b/i, "memory"],
  [/\bresearch\b/i, "research"],
  [/\bexperiment(?:s|ation)?\b/i, "experimentation"],
  [/\btraining\b/i, "training"],
];

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

/**
 * Extract structured multi-dimensional tags from content text.
 *
 * @param content - The raw text content to extract tags from.
 * @param contextPath - Optional context breadcrumb (header path) for additional signal.
 * @returns Structured MemoryTags with all dimensions populated.
 */
export function extractMemoryTags(content: string, contextPath?: string): MemoryTags {
  const fullText = contextPath ? `${contextPath}\n${content}` : content;

  const people = extractEntities(fullText, KNOWN_PEOPLE);
  const projects = extractEntities(fullText, KNOWN_PROJECTS);
  const places = extractEntities(fullText, KNOWN_PLACES);
  const specialized = extractEntities(fullText, KNOWN_SPECIALIZED);
  const concepts = extractEntities(fullText, CONCEPT_PATTERNS);

  return {
    concepts: dedupe(concepts).slice(0, 10),
    specialized: dedupe(specialized).slice(0, 10),
    people: dedupe(people).slice(0, 10),
    places: dedupe(places).slice(0, 5),
    projects: dedupe(projects).slice(0, 5),
  };
}

/**
 * Merge two MemoryTags objects (union of all tag arrays).
 */
export function mergeMemoryTags(a: MemoryTags, b: MemoryTags): MemoryTags {
  return {
    concepts: dedupe([...a.concepts, ...b.concepts]),
    specialized: dedupe([...a.specialized, ...b.specialized]),
    people: dedupe([...a.people, ...b.people]),
    places: dedupe([...a.places, ...b.places]),
    projects: dedupe([...a.projects, ...b.projects]),
  };
}

/**
 * Check if a MemoryTags object is empty (all arrays empty).
 */
export function isEmptyTags(tags: MemoryTags): boolean {
  return (
    tags.concepts.length === 0 &&
    tags.specialized.length === 0 &&
    tags.people.length === 0 &&
    tags.places.length === 0 &&
    tags.projects.length === 0
  );
}

/**
 * Flatten MemoryTags into a single string array (for FTS indexing).
 */
export function flattenTags(tags: MemoryTags): string[] {
  return dedupe([
    ...tags.concepts,
    ...tags.specialized,
    ...tags.people,
    ...tags.places,
    ...tags.projects,
  ]);
}

/**
 * Convert a flat string array (legacy format) to structured MemoryTags.
 * Attempts to classify each tag into the right dimension.
 */
export function flatTagsToStructured(flatTags: string[]): MemoryTags {
  const result: MemoryTags = {
    concepts: [],
    specialized: [],
    people: [],
    places: [],
    projects: [],
  };

  for (const tag of flatTags) {
    // Check each known list
    if (matchesAny(tag, KNOWN_PEOPLE)) {
      result.people.push(canonicalize(tag, KNOWN_PEOPLE));
    } else if (matchesAny(tag, KNOWN_PROJECTS)) {
      result.projects.push(canonicalize(tag, KNOWN_PROJECTS));
    } else if (matchesAny(tag, KNOWN_PLACES)) {
      result.places.push(canonicalize(tag, KNOWN_PLACES));
    } else if (matchesAny(tag, KNOWN_SPECIALIZED)) {
      result.specialized.push(canonicalize(tag, KNOWN_SPECIALIZED));
    } else if (matchesAny(tag, CONCEPT_PATTERNS)) {
      result.concepts.push(canonicalize(tag, CONCEPT_PATTERNS));
    } else {
      // Default: put in concepts
      result.concepts.push(tag);
    }
  }

  return {
    concepts: dedupe(result.concepts),
    specialized: dedupe(result.specialized),
    people: dedupe(result.people),
    places: dedupe(result.places),
    projects: dedupe(result.projects),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractEntities(text: string, patterns: Array<[RegExp, string]>): string[] {
  const found: string[] = [];
  for (const [pattern, canonical] of patterns) {
    if (pattern.test(text)) {
      found.push(canonical);
    }
  }
  return found;
}

function matchesAny(tag: string, patterns: Array<[RegExp, string]>): boolean {
  return patterns.some(([pattern]) => pattern.test(tag));
}

function canonicalize(tag: string, patterns: Array<[RegExp, string]>): string {
  for (const [pattern, canonical] of patterns) {
    if (pattern.test(tag)) {
      return canonical;
    }
  }
  return tag;
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
