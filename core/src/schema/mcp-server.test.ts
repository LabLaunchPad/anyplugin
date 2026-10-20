/**
 * The MCP server schema's cross-field rules (P2-7).
 *
 * ── Why this is a defect and not a preference ─────────────────────────────
 *
 * The transport decides WHICH fields are meaningful, and every adapter
 * branches on it exactly here: `if (server.transport === "http")` writes a
 * URL, and the stdio branch writes a command. So a server that declares
 * `transport: http` and no url is not a server — it is a config that emits a
 * native artifact pointing at nothing. The schema accepted it, so the
 * failure surfaced at the user's agent, not at the manifest.
 *
 * The same is true in the other direction: a stdio server with no command
 * emits a config that tries to spawn an empty command.
 */
import { describe, it, expect } from "vitest";
import { McpServerSchema } from "./index.js";

describe("the MCP server schema", () => {
  it("accepts a stdio server that names a command", () => {
    const parsed = McpServerSchema.safeParse({ transport: "stdio", command: "node", args: ["server.js"] });
    expect(parsed.success).toBe(true);
  });

  it("accepts an http server that names a url", () => {
    const parsed = McpServerSchema.safeParse({ transport: "http", url: "https://example.test/mcp" });
    expect(parsed.success).toBe(true);
  });

  it("REFUSES an http server with no url", () => {
    const parsed = McpServerSchema.safeParse({ transport: "http" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["url"]);
      expect(parsed.error.issues[0]?.message).toMatch(/must name a url/);
    }
  });

  it("REFUSES a stdio server with no command", () => {
    const parsed = McpServerSchema.safeParse({ transport: "stdio" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["command"]);
      expect(parsed.error.issues[0]?.message).toMatch(/must name a command/);
    }
  });

  it("REFUSES a server with no transport and no command — the default is stdio", () => {
    // The transport DEFAULTS to stdio, so a server with no fields at all is
    // a stdio server with no command, and it is refused for the same reason.
    const parsed = McpServerSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("still refuses unknown fields", () => {
    const parsed = McpServerSchema.safeParse({ transport: "stdio", command: "node", nope: 1 });
    expect(parsed.success).toBe(false);
  });
});
