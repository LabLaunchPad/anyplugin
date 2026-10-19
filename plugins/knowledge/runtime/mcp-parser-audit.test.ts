import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

function runMcpServer(input: string, bundleDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const serverPath = resolve("plugins/knowledge/runtime/mcp-server.js");
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ANYPLUGIN_OKF_BUNDLE: bundleDir },
      cwd: bundleDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function callTool(bundleDir: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n";
  const result = await runMcpServer(init + call, bundleDir);
  expect(result.code).toBe(0);
  const lines = result.stdout.trim().split("\n");
  const response = JSON.parse(lines[lines.length - 1]);
  return JSON.parse(response.result.content[0].text);
}

describe("MCP server frontmatter parser — audit regression tests (Finding I)", () => {
  let testRoot: string;
  let bundleDir: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "mcp-parser-test-"));
    bundleDir = join(testRoot, "knowledge");
    await mkdir(join(bundleDir, "agents"), { recursive: true });

    // A concept exercising every YAML shape OKF frontmatter uses.
    await writeFile(
      join(bundleDir, "agents", "test.md"),
      `---
type: Agent
title: Test Agent
description: A test agent
verified: []
status: stable
tags: [test, alpha, beta]
generated:
  by: anyplugin/design@0.1.1
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://example.com/a
    id: "1"
    title: First source
  - resource: https://example.com/b
    id: "2"
    title: Second source
---
Body content`,
    );

    await writeFile(
      join(bundleDir, "verified.md"),
      `---
type: Test
title: Verified
verified:
  - by: human:alice
    at: 2026-08-22T09:30:00+00:00
---
Body`,
    );

    await writeFile(
      join(bundleDir, "bare.md"),
      `---
type: Test
title: Bare Keys Work
unquoted: value
---
Body`,
    );

    await writeFile(
      join(bundleDir, "list.md"),
      `---
type: Test
title: List Test
tags:
  - tag1
  - tag2
---
Body`,
    );
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it("parses a flow sequence into an array, not a string", async () => {
    const concept = (await callTool(bundleDir, "okf_read", { concept: "agents/test" })) as {
      frontmatter: Record<string, unknown>;
    };
    expect(concept.frontmatter["tags"]).toEqual(["test", "alpha", "beta"]);
    expect(Array.isArray(concept.frontmatter["tags"])).toBe(true);
  });

  it("parses an empty flow sequence as an empty array (trust stays unverified)", async () => {
    const concept = (await callTool(bundleDir, "okf_read", { concept: "agents/test" })) as {
      frontmatter: Record<string, unknown>;
    };
    expect(concept.frontmatter["verified"]).toEqual([]);
    expect(Array.isArray(concept.frontmatter["verified"])).toBe(true);

    const index = (await callTool(bundleDir, "okf_index", {})) as Array<{ id: string; trust: string }>;
    const entry = index.find((c) => c.id === "agents/test");
    expect(entry).toBeDefined();
    // `verified: []` means NOTHING was verified — not "machine-confirmed".
    expect(entry!.trust).toBe("unverified");
  });

  it("parses a nested mapping", async () => {
    const concept = (await callTool(bundleDir, "okf_read", { concept: "agents/test" })) as {
      frontmatter: Record<string, unknown>;
    };
    expect(concept.frontmatter["generated"]).toEqual({
      by: "anyplugin/design@0.1.1",
      at: "2026-08-22T09:30:00+00:00",
    });
  });

  it("parses a block sequence of mappings", async () => {
    const concept = (await callTool(bundleDir, "okf_read", { concept: "agents/test" })) as {
      frontmatter: Record<string, unknown>;
    };
    expect(concept.frontmatter["sources"]).toEqual([
      { resource: "https://example.com/a", id: "1", title: "First source" },
      { resource: "https://example.com/b", id: "2", title: "Second source" },
    ]);
  });

  it("parses a block sequence of scalars", async () => {
    const concept = (await callTool(bundleDir, "okf_read", { concept: "list" })) as {
      frontmatter: Record<string, unknown>;
    };
    expect(concept.frontmatter["tags"]).toEqual(["tag1", "tag2"]);
  });

  it("computes the human-reviewed trust tier from a verified list", async () => {
    const index = (await callTool(bundleDir, "okf_index", {})) as Array<{ id: string; trust: string }>;
    const entry = index.find((c) => c.id === "verified");
    expect(entry).toBeDefined();
    expect(entry!.trust).toBe("human-reviewed");
  });

  it("still accepts bare keys without quotes", async () => {
    const concept = (await callTool(bundleDir, "okf_read", { concept: "bare" })) as {
      frontmatter: Record<string, unknown>;
    };
    expect(concept.frontmatter["unquoted"]).toBe("value");
    expect(concept.frontmatter["title"]).toBe("Bare Keys Work");
  });

  it("reports tags in okf_index", async () => {
    const index = (await callTool(bundleDir, "okf_index", {})) as Array<{ id: string; tags: string[] }>;
    const entry = index.find((c) => c.id === "agents/test");
    expect(entry).toBeDefined();
    expect(entry!.tags).toEqual(["test", "alpha", "beta"]);
  });

  it("does not crash on malformed frontmatter", async () => {
    await writeFile(
      join(bundleDir, "malformed.md"),
      `---
type: Test
title: "Malformed: frontmatter
unclosed quote
---
Body`,
    );
    const concept = (await callTool(bundleDir, "okf_read", { concept: "malformed" })) as {
      frontmatter: Record<string, unknown>;
    };
    // The server answers rather than dying — a broken concept must not take
    // the whole MCP server down.
    expect(concept).toBeDefined();
  });
});
