#!/usr/bin/env node
/**
 * AnyPlugin OKF MCP server — dependency-free, self-contained.
 * Speaks the MCP stdio protocol (JSON-RPC 2.0) with three tools:
 *   okf_index(bundle?)  → concept list {id, type, title, description, status, trust}
 *   okf_read(concept, bundle?) → {frontmatter, body}
 *   okf_search(query, bundle?) → matching concepts (id/type/tags/title/body substring)
 * Bundle resolution: bundle arg > ANYPLUGIN_OKF_BUNDLE > <server>/../knowledge > <cwd>/knowledge
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * SafePath boundary (spec §1.1, self-contained inline — the runtime ships no
 * dependencies): a bundle is served only when it exists AND its realpath is
 * one of, or inside one of, the authorized roots (the operator-configured
 * bundle, the plugin's own bundled knowledge, or the working directory).
 */
function authorizedRoots() {
  const candidates = [
    process.env["ANYPLUGIN_OKF_BUNDLE"],
    join(SERVER_DIR, "..", "knowledge"),
    process.cwd(),
  ].filter(Boolean);
  const roots = [];
  for (const c of candidates) {
    try {
      if (existsSync(c)) roots.push(realpathSync(c));
    } catch {
      /* unreadable root — skip */
    }
  }
  return roots;
}

function isUnder(path, root) {
  if (path === root) return true;
  const norm = process.platform === "win32" ? (p) => p.toLowerCase() : (p) => p;
  return norm(path).startsWith(norm(root.endsWith(sep) ? root : root + sep));
}

function resolveBundle(explicit) {
  const roots = authorizedRoots();
  const candidates = [
    explicit,
    process.env["ANYPLUGIN_OKF_BUNDLE"],
    join(SERVER_DIR, "..", "knowledge"),
    join(process.cwd(), "knowledge"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const real = realpathSync(c);
    if (roots.some((r) => isUnder(real, r))) return real;
  }
  return null;
}

function walkMd(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkMd(abs, base, out);
    else if (entry.name.endsWith(".md")) out.push({ rel: relative(base, abs).split("\\").join("/"), abs });
  }
  return out;
}

/** Lenient frontmatter reader — good enough for listing/reading; validation uses the anyplugin CLI. */
function parseMd(text) {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const first = text.indexOf("\n");
  const rest = text.slice(first + 1);
  const close = rest.search(/^(---|\.\.\.)\s*$/m);
  if (close < 0) return { fm: {}, body: text };
  const fmText = rest.slice(0, close);
  const body = rest.slice(rest.indexOf("\n", close) + 1);
  const fm = {};
  let listKey = null;
  for (const line of fmText.split(/\r?\n/)) {
    if (/^\s*-\s+/.test(line) && listKey) {
      const val = line.replace(/^\s*-\s+/, "").trim().replace(/^['"]|['"]$/g, "");
      if (Array.isArray(fm[listKey])) fm[listKey].push(val);
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      const key = m[1];
      const val = m[2].trim().replace(/^['"]|['"]$/g, "");
      if (val === "") {
        fm[key] = []; // maybe a list; scalar set later if no items follow
        listKey = key;
      } else {
        fm[key] = val;
        listKey = null;
      }
    }
  }
  return { fm, body };
}

function trustTier(fm) {
  const v = fm["verified"];
  const list = Array.isArray(v) ? v : v ? [v] : [];
  if (!list.length) return "unverified";
  return list.some((e) => typeof e === "object" && String(e.by ?? "").startsWith("human:"))
    ? "human-reviewed"
    : "machine-confirmed";
}

function loadConcepts(bundleDir) {
  const concepts = [];
  for (const { rel, abs } of walkMd(bundleDir)) {
    if (rel === "index.md" || rel.endsWith("/index.md") || rel === "log.md" || rel.endsWith("/log.md")) continue;
    const { fm, body } = parseMd(readFileSync(abs, "utf8"));
    concepts.push({
      id: rel.replace(/\.md$/, ""),
      type: String(fm["type"] ?? "Unknown"),
      title: String(fm["title"] ?? rel.replace(/\.md$/, "")),
      description: String(fm["description"] ?? ""),
      tags: Array.isArray(fm["tags"]) ? fm["tags"] : [],
      status: String(fm["status"] ?? "stable"),
      trust: trustTier(fm),
      fm,
      body,
      abs,
    });
  }
  return concepts;
}

const TOOLS = [
  {
    name: "okf_index",
    description: "List all concepts in the OKF knowledge bundle with type, title, description, status, and trust tier.",
    inputSchema: { type: "object", properties: { bundle: { type: "string", description: "Optional absolute bundle dir (default: auto-detect)" } }, additionalProperties: false },
  },
  {
    name: "okf_read",
    description: "Read one OKF concept (frontmatter + body) by concept id (bundle-relative path without .md).",
    inputSchema: {
      type: "object",
      properties: { concept: { type: "string", description: "Concept id, e.g. agents/claude-code" }, bundle: { type: "string" } },
      required: ["concept"],
      additionalProperties: false,
    },
  },
  {
    name: "okf_search",
    description: "Search concepts by substring across id, title, description, tags, type, and body.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, bundle: { type: "string" }, limit: { type: "number", description: "Max results (default 10)" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function callTool(name, args) {
  const bundleDir = resolveBundle(args.bundle);
  if (!bundleDir) throw new Error("no OKF bundle found (pass bundle, set ANYPLUGIN_OKF_BUNDLE, or create ./knowledge)");
  const concepts = loadConcepts(bundleDir);
  if (name === "okf_index") {
    return concepts.map((c) => ({ id: c.id, type: c.type, title: c.title, description: c.description, status: c.status, trust: c.trust, tags: c.tags }));
  }
  if (name === "okf_read") {
    const c = concepts.find((x) => x.id === String(args.concept).replace(/\.md$/, ""));
    if (!c) throw new Error(`concept not found: ${args.concept}`);
    return { id: c.id, frontmatter: c.fm, body: c.body };
  }
  if (name === "okf_search") {
    const q = String(args.query).toLowerCase();
    const limit = typeof args.limit === "number" ? args.limit : 10;
    return concepts
      .filter((c) =>
        [c.id, c.title, c.description, c.type, ...(c.tags ?? []), c.body].join("\n").toLowerCase().includes(q),
      )
      .slice(0, limit)
      .map((c) => ({ id: c.id, type: c.type, title: c.title, description: c.description, status: c.status, trust: c.trust }));
  }
  throw new Error(`unknown tool: ${name}`);
}

const serverInfo = { name: "anyplugin-okf", version: "0.1.1" };

function handleMessage(msg) {
  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo,
      },
    };
  }
  if (msg.method === "notifications/initialized" || msg.method?.startsWith("notifications/")) {
    return null; // notification — no response
  }
  if (msg.method === "ping") {
    return { jsonrpc: "2.0", id: msg.id, result: {} };
  }
  if (msg.method === "tools/list") {
    return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
  }
  if (msg.method === "tools/call") {
    const tool = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    try {
      const result = callTool(tool, args);
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: String(err && err.message ? err.message : err) }], isError: true },
      };
    }
  }
  if (msg.id !== undefined) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
  return null;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const response = handleMessage(msg);
  if (response) process.stdout.write(JSON.stringify(response) + "\n");
});
rl.on("close", () => process.exit(0));
