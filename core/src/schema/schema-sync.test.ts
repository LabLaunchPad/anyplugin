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

  it("mcp server item properties match McpServerSchema", async () => {
    const doc = JSON.parse(await readFile(schemaPath, "utf8"));
    const serverProps = doc["properties"]["mcp"]["properties"]["servers"]["additionalProperties"]["properties"];
    expect(Object.keys(serverProps).sort()).toEqual(Object.keys(McpServerSchema.shape).sort());
    expect(serverProps["transport"]["enum"]).toEqual(["stdio", "http"]);
  });
});
