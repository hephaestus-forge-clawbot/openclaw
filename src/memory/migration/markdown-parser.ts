/**
 * Markdown memory file parser.
 *
 * Splits markdown files (MEMORY.md, daily logs, person files) into
 * atomic "chunks" suitable for embedding and storage in the Hephie
 * 4-tier memory system.
 */

import type { MemoryTags, MemoryTier } from "../storage/types.js";
import { extractMemoryTags, mergeMemoryTags } from "../tags/extractor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedChunk {
  /** The raw markdown content of this chunk. */
  content: string;

  /** Markdown-stripped plain text for embedding. */
  plainText: string;

  /** Context breadcrumb, e.g. "## Significant Events > ### 2026-02-13". */
  contextPath: string;

  /** Inferred memory tier. */
  tier: MemoryTier;

  /** Inferred category. */
  category: string;

  /** Extracted person name (if the chunk is about a specific person). */
  person?: string;

  /** Tags derived from headers / content keywords (structured multi-dimensional). */
  tags: MemoryTags;

  /** Timestamp (Unix ms) — from file date or parsed from section headers. */
  createdAt: number;

  /** The source file path. */
  source: string;
}

export interface ParseOptions {
  /** The file path (used as `source` and for date extraction). */
  filePath: string;

  /** Override tier (otherwise inferred from file type). */
  tier?: MemoryTier;

  /** Override person tag for all chunks in this file. */
  person?: string;

  /** Override created_at for all chunks (Unix ms). */
  createdAt?: number;
}

// ---------------------------------------------------------------------------
// Category inference
// ---------------------------------------------------------------------------

/** Known person names to assist detection. */
const KNOWN_PEOPLE = [
  "antreas",
  "father",
  "dad",
  "laura",
  "giannis",
  "andreas",
  "fady",
  "thomas",
  "paul",
  "aris",
  "pasquale",
  "carlos",
  "dante",
];

const DECISION_PATTERNS = /\b(decided|decision|chose|choose|ruling|resolved to)\b/i;
const LESSON_PATTERNS = /\b(learned|lesson|never again|takeaway|key learning|mistake)\b/i;
const EVENT_PATTERNS =
  /\b(event|launched|shipped|confirmed|merged|completed|happened|released|deployed)\b/i;
const PREFERENCE_PATTERNS = /\b(prefers?|likes?|wants?|loves?|hates?|dislikes?|favourite)\b/i;
const EMOTION_PATTERNS = /\b(feels?|feeling|emotion|happy|sad|angry|proud|frustrated|anxious)\b/i;
const PROJECT_PATTERNS =
  /\b(project|repo|codebase|sprint|implementation|built|building|architecture)\b/i;

/**
 * Infer a memory category from chunk text using keyword matching.
 */
export function inferCategory(text: string, person?: string): string {
  const lower = text.toLowerCase();

  // Person detection: explicit person tag or mentions a known person
  if (person) {
    return "person";
  }
  for (const name of KNOWN_PEOPLE) {
    // Require word boundary: "antreas" not "antreas'" etc
    if (new RegExp(`\\b${name}\\b`, "i").test(lower)) {
      return "person";
    }
  }

  if (DECISION_PATTERNS.test(lower)) {
    return "decision";
  }
  if (LESSON_PATTERNS.test(lower)) {
    return "lesson";
  }
  if (PREFERENCE_PATTERNS.test(lower)) {
    return "preference";
  }
  if (EMOTION_PATTERNS.test(lower)) {
    return "emotion";
  }
  if (PROJECT_PATTERNS.test(lower)) {
    return "project";
  }
  if (EVENT_PATTERNS.test(lower)) {
    return "event";
  }

  return "fact";
}

/**
 * Extract a person name from chunk text (first known person mentioned).
 */
export function extractPerson(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const name of KNOWN_PEOPLE) {
    if (new RegExp(`\\b${name}\\b`, "i").test(lower)) {
      // Return properly cased version
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Markdown stripping
// ---------------------------------------------------------------------------

/**
 * Strip markdown formatting to produce clean plain text for embedding.
 */
export function stripMarkdown(md: string): string {
  return (
    md
      // Remove emphasis markers
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      // Remove headers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove links but keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      // Remove inline code
      .replace(/`([^`]+)`/g, "$1")
      // Remove blockquotes
      .replace(/^>\s+/gm, "")
      // Remove horizontal rules
      .replace(/^---+$/gm, "")
      // Remove bullet markers
      .replace(/^[-*+]\s+/gm, "")
      // Remove numbered list markers
      .replace(/^\d+\.\s+/gm, "")
      // Remove HTML tags
      .replace(/<[^>]+>/g, "")
      // Remove emoji shortcodes
      .replace(/:[a-z_]+:/g, "")
      // Collapse whitespace
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

/**
 * Extract tags from a header path and chunk content.
 *
 * Returns structured MemoryTags using the multi-dimensional tag extractor,
 * with additional header-derived keywords merged into the concepts dimension.
 */
export function extractTags(contextPath: string, content: string): MemoryTags {
  // Use the structured tag extractor for content + context
  const structuredTags = extractMemoryTags(content, contextPath);

  // Also extract header-derived keywords and merge into concepts
  const headerKeywords = extractHeaderKeywords(contextPath);
  if (headerKeywords.length > 0) {
    const merged = mergeMemoryTags(structuredTags, {
      concepts: headerKeywords,
      specialized: [],
      people: [],
      places: [],
      projects: [],
    });
    return merged;
  }

  return structuredTags;
}

/**
 * Extract keyword tags from context path headers (legacy behavior).
 */
function extractHeaderKeywords(contextPath: string): string[] {
  const tags = new Set<string>();

  const headerWords = contextPath
    .replace(/^#+\s*/gm, "")
    .replace(/[>#—\-|]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => w.toLowerCase());

  for (const word of headerWords) {
    // Skip date-like tokens and common filler
    if (/^\d{4}/.test(word) || /^\d+$/.test(word)) {
      continue;
    }
    if (["the", "and", "for", "from", "with", "about", "gmt"].includes(word)) {
      continue;
    }
    tags.add(word);
  }

  return [...tags].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

/**
 * Parse a date from a file path like `memory/2026-02-13.md`.
 */
export function parseDateFromPath(filePath: string): Date | null {
  const match = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return null;
  }
  const d = new Date(match[1] + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a time from a section header like "## 20:25 GMT — Something".
 */
export function parseTimeFromHeader(header: string, baseDate: Date): Date {
  const timeMatch = header.match(/(\d{1,2}):(\d{2})\s*(?:GMT|UTC)?/);
  if (!timeMatch) {
    return baseDate;
  }

  const hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);

  const result = new Date(baseDate);
  result.setUTCHours(hours, minutes, 0, 0);
  return result;
}

// ---------------------------------------------------------------------------
// Section splitting
// ---------------------------------------------------------------------------

interface Section {
  /** The header line (e.g. "## Core Truths I've Learned"). */
  header: string;

  /** Header depth (number of # chars). */
  depth: number;

  /** Body text under this header (before next header of same or higher level). */
  body: string;

  /** Sub-sections (### under ##, etc). */
  children: Section[];
}

/**
 * Parse a markdown string into a tree of sections by header depth.
 */
export function parseSections(markdown: string, minDepth = 2): Section[] {
  const lines = markdown.split("\n");
  const rootSections: Section[] = [];
  const stack: Section[] = [];

  let currentBody: string[] = [];

  function flushBody() {
    if (stack.length > 0) {
      stack[stack.length - 1].body = currentBody.join("\n").trim();
    }
    currentBody = [];
  }

  for (const line of lines) {
    const headerMatch = line.match(/^(#{2,6})\s+(.+)/);
    if (!headerMatch) {
      currentBody.push(line);
      continue;
    }

    const depth = headerMatch[1].length;
    if (depth < minDepth) {
      currentBody.push(line);
      continue;
    }

    flushBody();

    const section: Section = {
      header: headerMatch[2].trim(),
      depth,
      body: "",
      children: [],
    };

    // Pop stack until we find a parent (lower depth)
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      rootSections.push(section);
    } else {
      stack[stack.length - 1].children.push(section);
    }

    stack.push(section);
  }

  flushBody();

  return rootSections;
}

// ---------------------------------------------------------------------------
// Chunk splitting within a section
// ---------------------------------------------------------------------------

/**
 * Split a section body into atomic chunks.
 *
 * Rules:
 * - Bullet-point groups become individual chunks (1-5 bullets each)
 * - Paragraphs are split if > 5 sentences
 * - Very short content (<20 chars non-whitespace) is skipped
 */
export function splitIntoAtomicChunks(body: string): string[] {
  if (!body.trim()) {
    return [];
  }

  const chunks: string[] = [];
  const lines = body.split("\n");

  let currentChunk: string[] = [];
  let inBulletGroup = false;
  let bulletCount = 0;

  function flushChunk() {
    const text = currentChunk.join("\n").trim();
    if (text && stripMarkdown(text).length >= 20) {
      chunks.push(text);
    }
    currentChunk = [];
    bulletCount = 0;
  }

  for (const line of lines) {
    const isBullet = /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
    const isEmpty = !line.trim();

    if (isEmpty) {
      // Empty line between bullet groups → flush
      if (inBulletGroup && currentChunk.length > 0) {
        flushChunk();
        inBulletGroup = false;
      } else if (currentChunk.length > 0) {
        // End of paragraph
        flushChunk();
      }
      continue;
    }

    if (isBullet) {
      if (!inBulletGroup && currentChunk.length > 0) {
        // Switching from paragraph to bullets — flush paragraph
        flushChunk();
      }
      inBulletGroup = true;
      currentChunk.push(line);
      bulletCount++;

      // Group up to 5 bullets, then flush
      if (bulletCount >= 5) {
        flushChunk();
      }
    } else {
      if (inBulletGroup && currentChunk.length > 0) {
        // Continuation line under a bullet (indented context)
        currentChunk.push(line);
      } else {
        inBulletGroup = false;
        currentChunk.push(line);
      }
    }
  }

  // Flush remaining
  flushChunk();

  return chunks;
}

// ---------------------------------------------------------------------------
// Main parsers
// ---------------------------------------------------------------------------

/**
 * Parse MEMORY.md into atomic chunks.
 */
export function parseMemoryMd(markdown: string, opts: ParseOptions): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const baseDate = opts.createdAt ?? Date.now();

  const sections = parseSections(markdown, 2);

  function processSection(section: Section, parentPath: string) {
    const contextPath = parentPath
      ? `${parentPath} > ${"#".repeat(section.depth)} ${section.header}`
      : `${"#".repeat(section.depth)} ${section.header}`;

    // If this section has children, process them
    if (section.children.length > 0) {
      // If the section also has its own body, chunk it
      if (section.body.trim()) {
        const atomics = splitIntoAtomicChunks(section.body);
        for (const atomic of atomics) {
          const person = opts.person ?? extractPerson(atomic);
          chunks.push({
            content: atomic,
            plainText: stripMarkdown(`${section.header}. ${atomic}`),
            contextPath,
            tier: opts.tier ?? "long_term",
            category: inferCategory(atomic, person),
            person,
            tags: extractTags(contextPath, atomic),
            createdAt: baseDate,
            source: opts.filePath,
          });
        }
      }

      for (const child of section.children) {
        processSection(child, contextPath);
      }
    } else {
      // Leaf section — chunk the body
      const fullBody = section.body || "";
      const atomics = splitIntoAtomicChunks(fullBody);

      if (atomics.length === 0 && fullBody.trim().length < 20) {
        // Header-only or trivially short — create one chunk from header
        const headerText = section.header;
        if (stripMarkdown(headerText).length >= 20) {
          const person = opts.person ?? extractPerson(headerText);
          chunks.push({
            content: headerText,
            plainText: stripMarkdown(headerText),
            contextPath,
            tier: opts.tier ?? "long_term",
            category: inferCategory(headerText, person),
            person,
            tags: extractTags(contextPath, headerText),
            createdAt: baseDate,
            source: opts.filePath,
          });
        }
        return;
      }

      for (const atomic of atomics) {
        const person = opts.person ?? extractPerson(atomic);
        chunks.push({
          content: atomic,
          plainText: stripMarkdown(`${section.header}. ${atomic}`),
          contextPath,
          tier: opts.tier ?? "long_term",
          category: inferCategory(atomic, person),
          person,
          tags: extractTags(contextPath, atomic),
          createdAt: baseDate,
          source: opts.filePath,
        });
      }
    }
  }

  for (const section of sections) {
    processSection(section, "");
  }

  return chunks;
}

/**
 * Parse a daily log file into chunks.
 */
export function parseDailyLog(markdown: string, opts: ParseOptions): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const fileDate = parseDateFromPath(opts.filePath) ?? new Date();

  const sections = parseSections(markdown, 2);

  function processSection(section: Section, parentPath: string) {
    const contextPath = parentPath
      ? `${parentPath} > ${"#".repeat(section.depth)} ${section.header}`
      : `${"#".repeat(section.depth)} ${section.header}`;

    // Extract timestamp from header
    const timestamp = parseTimeFromHeader(section.header, fileDate);
    const createdAt = opts.createdAt ?? timestamp.getTime();

    if (section.children.length > 0) {
      // Process own body if present
      if (section.body.trim()) {
        const atomics = splitIntoAtomicChunks(section.body);
        for (const atomic of atomics) {
          const person = opts.person ?? extractPerson(atomic);
          chunks.push({
            content: atomic,
            plainText: stripMarkdown(`${section.header}. ${atomic}`),
            contextPath,
            tier: opts.tier ?? "short_term",
            category: inferCategory(atomic, person),
            person,
            tags: extractTags(contextPath, atomic),
            createdAt,
            source: opts.filePath,
          });
        }
      }

      for (const child of section.children) {
        processSection(child, contextPath);
      }
    } else {
      // Leaf section — chunk the full body
      const fullBody = section.body || "";

      // For daily logs, keep the whole section as one chunk if it's not too long
      if (fullBody.trim().length > 0) {
        // If body is moderate size, keep as one chunk with header for context
        const combined = `${section.header}\n\n${fullBody}`;
        const plain = stripMarkdown(combined);

        if (plain.length < 1500) {
          // Single chunk for the whole section
          const person = opts.person ?? extractPerson(combined);
          chunks.push({
            content: combined,
            plainText: plain,
            contextPath,
            tier: opts.tier ?? "short_term",
            category: inferCategory(combined, person),
            person,
            tags: extractTags(contextPath, combined),
            createdAt,
            source: opts.filePath,
          });
        } else {
          // Split into atomic chunks
          const atomics = splitIntoAtomicChunks(fullBody);
          for (const atomic of atomics) {
            const person = opts.person ?? extractPerson(atomic);
            chunks.push({
              content: atomic,
              plainText: stripMarkdown(`${section.header}. ${atomic}`),
              contextPath,
              tier: opts.tier ?? "short_term",
              category: inferCategory(atomic, person),
              person,
              tags: extractTags(contextPath, atomic),
              createdAt,
              source: opts.filePath,
            });
          }
        }
      }
    }
  }

  for (const section of sections) {
    processSection(section, "");
  }

  return chunks;
}

/**
 * Parse a person file into chunks, tagging all with the person name.
 */
export function parsePersonFile(markdown: string, opts: ParseOptions): ParsedChunk[] {
  return parseMemoryMd(markdown, {
    ...opts,
    tier: opts.tier ?? "long_term",
    person: opts.person,
  });
}
