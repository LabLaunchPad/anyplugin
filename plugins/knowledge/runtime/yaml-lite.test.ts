import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYamlPkg } from "yaml";
import { parseYaml } from "./yaml-lite.js";

/**
 * The runtime's YAML parser must agree with the `yaml` package.
 *
 * The MCP server is dependency-free, so it cannot use `yaml` — but it MUST
 * produce the same shapes, because the OKF validator (which does use `yaml`)
 * and the MCP tools report the same bundle to different consumers. A
 * divergence means one of them is lying.
 *
 * The strongest available evidence is a differential test: parse every file of
 * the REAL knowledge bundle with both parsers and compare the results
 * structurally. Anything the real bundle exercises is then proven equivalent.
 */

function walkMarkdown(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(abs, base, out);
    else if (entry.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

/** Extract the frontmatter text of a markdown document, like the MCP server does. */
function frontmatterOf(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const first = text.indexOf("\n");
  if (first < 0) return null;
  const rest = text.slice(first + 1);
  const close = rest.search(/^(---|\.\.\.)\s*$/m);
  if (close < 0) return null;
  return rest.slice(0, close);
}

const KNOWLEDGE_ROOT = join(process.cwd(), "knowledge");

describe("MCP runtime YAML parser — equivalence with the yaml package (Finding I)", () => {
  it("parses every file of the real knowledge bundle identically to `yaml`", () => {
    const files = walkMarkdown(KNOWLEDGE_ROOT);
    expect(files.length).toBeGreaterThan(0);

    let compared = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const fm = frontmatterOf(text);
      if (fm === null) continue;
      const rel = relative(KNOWLEDGE_ROOT, file).split(sep).join("/");
      const expected = parseYamlPkg(fm);
      const actual = parseYaml(fm);
      expect(actual, `frontmatter mismatch in ${rel}`).toEqual(expected);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("parses a flow sequence into an array, not a string", () => {
    const fm = parseYaml("tags: [alpha, beta, gamma]");
    expect(fm).toEqual({ tags: ["alpha", "beta", "gamma"] });
    expect(Array.isArray(fm.tags)).toBe(true);
  });

  it("parses an empty flow sequence as an empty array", () => {
    const fm = parseYaml("verified: []");
    expect(fm).toEqual({ verified: [] });
    expect(Array.isArray(fm.verified)).toBe(true);
  });

  it("parses a nested mapping", () => {
    const fm = parseYaml("generated:\n  by: anyplugin/design@0.1.1\n  at: 2026-08-22T09:30:00+00:00");
    expect(fm).toEqual({
      generated: { by: "anyplugin/design@0.1.1", at: "2026-08-22T09:30:00+00:00" },
    });
  });

  it("parses a block sequence of mappings", () => {
    const fm = parseYaml(
      [
        "sources:",
        "  - resource: https://example.com/a",
        '    id: "1"',
        "    title: First",
        "  - resource: https://example.com/b",
        '    id: "2"',
        "    title: Second",
      ].join("\n"),
    );
    expect(fm).toEqual({
      sources: [
        { resource: "https://example.com/a", id: "1", title: "First" },
        { resource: "https://example.com/b", id: "2", title: "Second" },
      ],
    });
  });

  it("parses a block sequence of scalars", () => {
    const fm = parseYaml("tags:\n  - one\n  - two");
    expect(fm).toEqual({ tags: ["one", "two"] });
  });

  it("applies core-schema typing", () => {
    const fm = parseYaml(
      ["a: true", "b: false", "c: null", "d: 42", "e: 3.5", "f: yes", "g: ~"].join("\n"),
    );
    expect(fm).toEqual({ a: true, b: false, c: null, d: 42, e: 3.5, f: "yes", g: null });
  });

  it("keeps a URL with a colon intact", () => {
    const fm = parseYaml("resource: https://example.com/path?x=1");
    expect(fm).toEqual({ resource: "https://example.com/path?x=1" });
  });

  it("honours quotes and escapes", () => {
    const fm = parseYaml(['a: "line\\nbreak"', "b: 'it''s'", 'c: "say \\"hi\\""'].join("\n"));
    expect(fm).toEqual({ a: "line\nbreak", b: "it's", c: 'say "hi"' });
  });

  it("strips comments outside quotes but keeps # inside them", () => {
    const fm = parseYaml(['a: value # trailing comment', 'b: "has # inside"'].join("\n"));
    expect(fm).toEqual({ a: "value", b: "has # inside" });
  });

  it("parses a literal block scalar", () => {
    const fm = parseYaml("body: |\n  line one\n  line two");
    expect(fm).toEqual({ body: "line one\nline two\n" });
  });

  it("parses a flow mapping", () => {
    const fm = parseYaml("meta: {a: 1, b: two}");
    expect(fm).toEqual({ meta: { a: 1, b: "two" } });
  });

  it("returns null for an empty document", () => {
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("\n\n")).toBeNull();
  });
});
