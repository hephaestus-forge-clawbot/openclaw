/**
 * Person File Migration (Hephie Phase 3.1)
 *
 * Scans existing person files (memory/people/<name>.md) to extract
 * identity mappings, and optionally adds an `## Identities` section
 * to person files that have inline identity mentions but no formal section.
 */

import fs from "node:fs";
import path from "node:path";
import type { IdentityStore } from "./identity-map.js";
import type { ChannelIdentity } from "./types.js";
import { parseIdentitiesFromPersonFile, formatIdentitiesSection } from "./identity-map.js";

export interface MigrationResult {
  /** Person files scanned. */
  filesScanned: number;

  /** Files with identities found. */
  filesWithIdentities: number;

  /** Total identities discovered. */
  identitiesFound: number;

  /** Files that were updated (identities section added). */
  filesUpdated: number;

  /** Per-file details. */
  details: PersonFileScanResult[];
}

export interface PersonFileScanResult {
  /** File name (e.g., "alice.md"). */
  fileName: string;

  /** Canonical person name. */
  personName: string;

  /** Identities discovered. */
  identities: ChannelIdentity[];

  /** Whether the file already had a formal ## Identities section. */
  hadIdentitiesSection: boolean;

  /** Whether the file was updated. */
  updated: boolean;
}

/**
 * Scan a directory of person files and extract identity mappings.
 *
 * @param peopleDir - Path to the memory/people/ directory.
 * @param store - IdentityStore to populate with discovered identities.
 * @param opts - Migration options.
 * @returns Migration results.
 */
export function scanPersonFiles(
  peopleDir: string,
  store: IdentityStore,
  opts: { dryRun?: boolean; addIdentitiesSection?: boolean } = {},
): MigrationResult {
  const result: MigrationResult = {
    filesScanned: 0,
    filesWithIdentities: 0,
    identitiesFound: 0,
    filesUpdated: 0,
    details: [],
  };

  // Check if directory exists
  if (!fs.existsSync(peopleDir)) {
    return result;
  }

  const stat = fs.statSync(peopleDir);
  if (!stat.isDirectory()) {
    return result;
  }

  // List markdown files
  const files = fs.readdirSync(peopleDir).filter((f) => f.endsWith(".md"));

  for (const fileName of files) {
    const filePath = path.join(peopleDir, fileName);
    const personName = fileName.replace(/\.md$/, "").toLowerCase();

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    result.filesScanned++;

    const identities = parseIdentitiesFromPersonFile(content);
    const hadIdentitiesSection = /##\s*Identities/i.test(content);

    const scanResult: PersonFileScanResult = {
      fileName,
      personName,
      identities,
      hadIdentitiesSection,
      updated: false,
    };

    if (identities.length > 0) {
      result.filesWithIdentities++;
      result.identitiesFound += identities.length;

      // Register identities in the store
      store.registerUser(personName, identities);

      // Optionally add formal identities section
      if (opts.addIdentitiesSection && !hadIdentitiesSection && !opts.dryRun) {
        const section = formatIdentitiesSection(identities);
        if (section) {
          const updatedContent = content.trimEnd() + "\n\n" + section + "\n";
          try {
            fs.writeFileSync(filePath, updatedContent, "utf-8");
            scanResult.updated = true;
            result.filesUpdated++;
          } catch {
            // Best effort — don't fail migration for write errors
          }
        }
      }
    }

    result.details.push(scanResult);
  }

  return result;
}

/**
 * Extract the canonical person name from a person file path.
 */
export function personNameFromPath(filePath: string): string {
  return path.basename(filePath, ".md").toLowerCase();
}

/**
 * Check if a person file exists for a given name.
 */
export function personFileExists(peopleDir: string, name: string): boolean {
  const filePath = path.join(peopleDir, `${name.toLowerCase()}.md`);
  return fs.existsSync(filePath);
}

/**
 * Read identities from a specific person file.
 */
export function readPersonIdentities(peopleDir: string, name: string): ChannelIdentity[] {
  const filePath = path.join(peopleDir, `${name.toLowerCase()}.md`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseIdentitiesFromPersonFile(content);
  } catch {
    return [];
  }
}
