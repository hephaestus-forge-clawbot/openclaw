/**
 * Tests for Person File Migration (Hephie Phase 3.1)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityStore } from "./identity-map.js";
import {
  scanPersonFiles,
  personNameFromPath,
  personFileExists,
  readPersonIdentities,
} from "./person-file-migration.js";

describe("scanPersonFiles", () => {
  let tmpDir: string;
  let peopleDir: string;
  let store: IdentityStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hephie-migration-test-"));
    peopleDir = path.join(tmpDir, "people");
    fs.mkdirSync(peopleDir, { recursive: true });
    store = new IdentityStore();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should scan empty directory", () => {
    const result = scanPersonFiles(peopleDir, store);
    expect(result.filesScanned).toBe(0);
    expect(result.filesWithIdentities).toBe(0);
  });

  it("should scan person files with identities section", () => {
    fs.writeFileSync(
      path.join(peopleDir, "alice.md"),
      `# Alice

## Identities

- Telegram: 123456
- Slack: U02AY4DH803

## Notes

Some notes.
`,
    );

    const result = scanPersonFiles(peopleDir, store);
    expect(result.filesScanned).toBe(1);
    expect(result.filesWithIdentities).toBe(1);
    expect(result.identitiesFound).toBe(2);

    // Check store was populated
    expect(store.lookupByChannelId("telegram", "123456")).toBe("alice");
    expect(store.lookupByChannelId("slack", "U02AY4DH803")).toBe("alice");
  });

  it("should scan person files with inline identities", () => {
    fs.writeFileSync(
      path.join(peopleDir, "bob.md"),
      `# Bob

Met on Telegram. His Telegram ID: 987654321.
Also uses Slack ID: U0ABCDEF.
`,
    );

    const result = scanPersonFiles(peopleDir, store);
    expect(result.filesScanned).toBe(1);
    expect(result.filesWithIdentities).toBe(1);
    expect(store.lookupByChannelId("telegram", "987654321")).toBe("bob");
  });

  it("should handle multiple person files", () => {
    fs.writeFileSync(path.join(peopleDir, "alice.md"), `## Identities\n- Telegram: 111\n`);
    fs.writeFileSync(
      path.join(peopleDir, "bob.md"),
      `## Identities\n- Telegram: 222\n- Slack: U333\n`,
    );
    fs.writeFileSync(path.join(peopleDir, "carol.md"), `# Carol\nNo identities here.\n`);

    const result = scanPersonFiles(peopleDir, store);
    expect(result.filesScanned).toBe(3);
    expect(result.filesWithIdentities).toBe(2);
    expect(result.identitiesFound).toBe(3);
    expect(store.getUserCount()).toBe(2);
  });

  it("should skip non-md files", () => {
    fs.writeFileSync(path.join(peopleDir, "notes.txt"), "Some notes");
    fs.writeFileSync(path.join(peopleDir, "alice.md"), `## Identities\n- Telegram: 111\n`);

    const result = scanPersonFiles(peopleDir, store);
    expect(result.filesScanned).toBe(1);
  });

  it("should handle non-existent directory", () => {
    const result = scanPersonFiles("/nonexistent/path", store);
    expect(result.filesScanned).toBe(0);
  });

  it("should report details per file", () => {
    fs.writeFileSync(path.join(peopleDir, "alice.md"), `## Identities\n- Telegram: 111\n`);
    fs.writeFileSync(path.join(peopleDir, "bob.md"), `# Bob\nNo identities.\n`);

    const result = scanPersonFiles(peopleDir, store);
    expect(result.details).toHaveLength(2);

    const alice = result.details.find((d) => d.personName === "alice");
    expect(alice?.identities).toHaveLength(1);
    expect(alice?.hadIdentitiesSection).toBe(true);

    const bob = result.details.find((d) => d.personName === "bob");
    expect(bob?.identities).toHaveLength(0);
  });

  it("should add identities section when requested", () => {
    const filePath = path.join(peopleDir, "alice.md");
    fs.writeFileSync(filePath, `# Alice\n\nTelegram ID: 123456\nSlack ID: U789\n`);

    const result = scanPersonFiles(peopleDir, store, {
      addIdentitiesSection: true,
    });

    expect(result.filesUpdated).toBe(1);

    // Verify the file was updated
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("## Identities");
    expect(content).toContain("- Telegram: 123456");
  });

  it("should not add section in dry run mode", () => {
    const filePath = path.join(peopleDir, "alice.md");
    const original = `# Alice\n\nTelegram ID: 123456\n`;
    fs.writeFileSync(filePath, original);

    const result = scanPersonFiles(peopleDir, store, {
      addIdentitiesSection: true,
      dryRun: true,
    });

    expect(result.filesUpdated).toBe(0);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
  });

  it("should not duplicate identities section", () => {
    const filePath = path.join(peopleDir, "alice.md");
    fs.writeFileSync(filePath, `# Alice\n\n## Identities\n\n- Telegram: 123456\n`);

    const result = scanPersonFiles(peopleDir, store, {
      addIdentitiesSection: true,
    });

    // Should not update because section already exists
    expect(result.filesUpdated).toBe(0);
  });
});

describe("personNameFromPath", () => {
  it("should extract name from path", () => {
    expect(personNameFromPath("/home/user/people/alice.md")).toBe("alice");
    expect(personNameFromPath("bob.md")).toBe("bob");
  });
});

describe("personFileExists", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hephie-person-test-"));
    fs.writeFileSync(path.join(tmpDir, "alice.md"), "# Alice");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return true for existing file", () => {
    expect(personFileExists(tmpDir, "alice")).toBe(true);
  });

  it("should return false for non-existing file", () => {
    expect(personFileExists(tmpDir, "bob")).toBe(false);
  });

  it("should handle case-insensitive names", () => {
    expect(personFileExists(tmpDir, "alice")).toBe(true);
  });
});

describe("readPersonIdentities", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hephie-read-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should read identities from file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "alice.md"),
      `## Identities\n- Telegram: 123\n- Slack: U456\n`,
    );

    const identities = readPersonIdentities(tmpDir, "alice");
    expect(identities).toHaveLength(2);
  });

  it("should return empty for non-existent file", () => {
    const identities = readPersonIdentities(tmpDir, "nobody");
    expect(identities).toHaveLength(0);
  });
});
