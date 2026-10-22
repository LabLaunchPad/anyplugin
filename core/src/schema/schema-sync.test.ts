import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AnyPluginManifestSchema, HookSchema, CanonicalEvent, McpServerSchema } from "./index.js";

/** The shipped JSON Schema must stay in lockstep with the Zod source of truth. */
describe("anyplugin.plugin.schema.json sync", () => {
  const schemaPath = fileURLToPath(new URL("../../../anyplugin.plugin.schema.json", import.meta.url));

  it("exists and is valid JSON", async () => {
    const doc = JSON.parse(await readFile(schemaPath, "utf8"));
    expect(doc["$schema"]).toMatch(/draft-07/);
  });

  it("top-level properties match the Zod manifest shape", async () => {
    const doc = JSON.parse(await readFile(schemaPath, "utf8"));
    const zodKeys = Object.keys(AnyPluginManifestSchema.shape).sort();
    const jsonKeys = Object.keys(doc["properties"]).sort();
    expect(jsonKeys).toEqual(zodKeys);
    expect(doc["required"].sort()).toEqual(["description", "name", "version"]);
  });

  it("hook item properties match HookSchema and the canonical event enum", async () => {
    const doc = JSON.parse(await readFile(schemaPath, "utf8"));
    const hookProps = doc["properties"]["hooks"]["items"];
    expect(Object.keys(hookProps["properties"]).sort()).toEqual(Object.keys(HookSchema.shape).sort());
    expect(hookProps["properties"]["event"]["enum"]).toEqual(CanonicalEvent.options);
    expect(hookProps["properties"]["timeoutSec"]).toEqual({ type: "integer", minimum: 1, maximum: 600 });
  });

  it("the matcher's length limit agrees between the mirror and the parser", async () => {
    // The mirror and the Zod source must accept and refuse the SAME
    // patterns, or an editor's validation disagrees with the manifest
    // parser — and the user finds out at install time, not at save time.
    //
    // The length limit is the part JSON Schema can state exactly, and this
    // asserts both sides state the SAME one.
    const doc = JSON.parse(await readFile(schemaPath, "utf8"));
    const mirror = doc["properties"]["hooks"]["items"]["properties"]["match"];
    expect(mirror["maxLength"]).toBe(200);
    expect(HookSchema.shape.match.safeParse("a".repeat(200)).success).toBe(true);
    expect(HookSchema.shape.match.safeParse("a".repeat(201)).success).toBe(false);
  });

  it("the mirror's pattern rules agree with the parser on the patterns that matter", async () => {
    // The mirror states the ambiguity rules as `not.pattern` — the shapes a
    // JSON Schema CAN express. The parser's rule is broader (it understands
    // nested groups, which a regex cannot), so this asserts the two AGREE on
    // the cases the mirror claims, and that the parser refuses the shapes
    // the mirror cannot express.
    const doc = JSON.parse(await readFile(schemaPath, "utf8"));
    const mirror = doc["properties"]["hooks"]["items"]["properties"]["match"];
    const asRegex = new RegExp(mirror["not"]["pattern"]);

    // A pattern the mirror forbids must be refused by the parser too.
    for (const forbidden of ["(a+)+", "(a*)*", "(a{1,2})+", "(a+)+$"]) {
      expect(asRegex.test(forbidden), `the mirror should forbid ${forbidden}`).toBe(true);
      expect(
        HookSchema.shape.match.safeParse(forbidden).success,
        `the mirror forbids ${forbidden} but the parser accepts it`,
      ).toBe(false);
    }

    // The parser refuses the nested-group shape the mirror cannot express.
    expect(HookSchema.shape.match.safeParse("((a+))+$").success).toBe(false);
    // And accepts the shapes that must keep working.
    for (const ok of ["Bash", ".*", "^(Read|Write)$", "(Read|Write)+"]) {
      expect(HookSchema.shape.match.safeParse(ok).success, ok).toBe(true);
    }
  });

  it("mcp server item properties match McpServerSchema", async () => {
    const doc = JSON.parse(await readFile(schemaPath, "utf8"));
    const serverProps = doc["properties"]["mcp"]["properties"]["servers"]["additionalProperties"]["properties"];
    expect(Object.keys(serverProps).sort()).toEqual(Object.keys(McpServerSchema.shape).sort());
    expect(serverProps["transport"]["enum"]).toEqual(["stdio", "http"]);
  });
});
