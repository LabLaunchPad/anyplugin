import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateJournal,
  readJournal,
  writeJournal,
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_BASENAME,
  type InstallJournal,
} from "./journal.js";

/**
 * Journal migration — audit regression tests (Finding D, remaining part).
 *
 * The journal carries an explicit `schemaVersion`. Legacy journals written
 * before versioning existed are migrated forward on read. Unknown FUTURE
 * versions fail closed rather than being guessed at.
 */
describe("Journal migration — audit regression tests (Finding D)", () => {
  let testRoot: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "journal-migration-test-"));
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it("current schema version is 1", () => {
    expect(JOURNAL_SCHEMA_VERSION).toBe(1);
  });

  it("migrates a legacy journal (no schemaVersion) to the current schema", () => {
    const legacy = {
      installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      pluginId: "legacy-plugin",
      version: "0.3.0",
      agent: "opencode",
      files: [
        {
          file: "C:/tmp/config.json",
          kind: "json-merge",
          preInstallHash: "aaa",
          postInstallHash: "bbb",
          backupContent: '{"x":1}',
          ownedKeys: ["x"],
        },
      ],
    };

    const migrated = migrateJournal(legacy);
    expect(migrated.schemaVersion).toBe(JOURNAL_SCHEMA_VERSION);
    expect(migrated.installationId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(migrated.pluginId).toBe("legacy-plugin");
    expect(migrated.version).toBe("0.3.0");
    expect(migrated.agent).toBe("opencode");
    expect(migrated.files).toHaveLength(1);
    expect(migrated.files[0]!.kind).toBe("json-merge");
    expect(migrated.files[0]!.ownedKeys).toEqual(["x"]);
  });

  it("migrates a legacy journal with a copy entry", () => {
    const legacy = {
      installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      pluginId: "legacy-plugin",
      version: "0.3.0",
      agent: "claude-code",
      files: [
        {
          file: "C:/tmp/plugin",
          kind: "copy",
          preInstallHash: null,
          postInstallHash: "ccc",
          backupContent: null,
          ownedKeys: null,
          copiedFiles: ["a.txt", "nested/b.txt"],
        },
      ],
    };

    const migrated = migrateJournal(legacy);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.files[0]!.kind).toBe("copy");
    expect(migrated.files[0]!.copiedFiles).toEqual(["a.txt", "nested/b.txt"]);
  });

  it("defaults a missing version to 0.0.0 during migration", () => {
    const legacy = {
      installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      pluginId: "legacy-plugin",
      agent: "opencode",
      files: [],
    };

    const migrated = migrateJournal(legacy);
    expect(migrated.version).toBe("0.0.0");
  });

  it("rejects a legacy journal that is missing required fields", () => {
    expect(() => migrateJournal({ pluginId: "x" })).toThrow(/legacy journal missing required fields/);
  });

  it("rejects a legacy journal whose files field is not an array", () => {
    expect(() =>
      migrateJournal({
        installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        pluginId: "x",
        agent: "opencode",
        files: "nope",
      }),
    ).toThrow(/legacy journal missing required fields/);
  });

  it("rejects a non-object journal", () => {
    expect(() => migrateJournal(null)).toThrow("journal is not an object");
    expect(() => migrateJournal("string")).toThrow("journal is not an object");
    expect(() => migrateJournal(42)).toThrow("journal is not an object");
  });

  it("fails closed on an unknown FUTURE schema version", () => {
    expect(() =>
      migrateJournal({
        installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        pluginId: "x",
        version: "1.0.0",
        agent: "opencode",
        schemaVersion: 99,
        files: [],
      }),
    ).toThrow(/unsupported journal schema version: 99/);
  });

  it("fails closed on a schemaVersion of the wrong type", () => {
    expect(() =>
      migrateJournal({
        installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        pluginId: "x",
        version: "1.0.0",
        agent: "opencode",
        schemaVersion: "1",
        files: [],
      }),
    ).toThrow(/unsupported journal schema version/);
  });

  it("accepts a current-version journal unchanged", () => {
    const current: InstallJournal = {
      installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      pluginId: "x",
      version: "1.0.0",
      agent: "opencode",
      schemaVersion: 1,
      files: [],
    };
    const migrated = migrateJournal(current);
    expect(migrated).toEqual(current);
  });

  it("readJournal migrates a legacy journal on disk", async () => {
    const dir = join(testRoot, "legacy-on-disk");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, JOURNAL_BASENAME),
      JSON.stringify({
        installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        pluginId: "legacy-on-disk",
        version: "2.0.0",
        agent: "opencode",
        files: [],
      }),
    );

    const journal = await readJournal(dir);
    expect(journal).not.toBeNull();
    expect(journal!.schemaVersion).toBe(1);
    expect(journal!.pluginId).toBe("legacy-on-disk");
  });

  it("writeJournal always stamps the current schemaVersion", async () => {
    const dir = join(testRoot, "write-stamps");
    await mkdir(dir, { recursive: true });
    // Deliberately omit schemaVersion from the input.
    await writeJournal(dir, {
      installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      pluginId: "stamped",
      version: "1.0.0",
      agent: "opencode",
      schemaVersion: 0 as unknown as number,
      files: [],
    } as InstallJournal);

    const raw = JSON.parse(await readFile(join(dir, JOURNAL_BASENAME), "utf8")) as Record<string, unknown>;
    expect(raw["schemaVersion"]).toBe(JOURNAL_SCHEMA_VERSION);
  });

  it("a written journal round-trips through readJournal", async () => {
    const dir = join(testRoot, "round-trip");
    await mkdir(dir, { recursive: true });
    const journal: InstallJournal = {
      installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      pluginId: "round-trip",
      version: "1.2.3",
      agent: "codex",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      files: [
        {
          file: "C:/tmp/x.toml",
          kind: "marker",
          preInstallHash: null,
          postInstallHash: "abc",
          backupContent: null,
          ownedKeys: null,
        },
      ],
    };
    await writeJournal(dir, journal);
    const read = await readJournal(dir);
    expect(read).not.toBeNull();
    expect(read!.schemaVersion).toBe(1);
    expect(read!.files[0]!.kind).toBe("marker");
  });
});
