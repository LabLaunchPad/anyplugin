/**
 * OKF v0.2 (Open Knowledge Format) implementation — Google Cloud spec,
 * google/cloudplatform/open-knowledge-format SPEC.md. See knowledge/formats/okf-v02.md.
 *
 * Hard rules honored here: unknown frontmatter keys are PRESERVED on round-trip;
 * consumers never reject for optional-field absence, unknown types, or broken links;
 * YAML 1.2 core-schema semantics (ISO datetimes stay strings).
 */
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join, relative, dirname, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const OKF_VERSION = "0.2";
const RESERVED = new Set(["index.md", "log.md"]);

/** Preferred frontmatter key order (reference implementation order). */
const KNOWN_KEY_ORDER = [
  "type",
  "resource",
  "title",
  "description",
  "tags",
  "status",
  "generated",
  "verified",
  "stale_after",
  "sources",
  "usage_window",
] as const;

export interface OkfFrontmatter {
  [key: string]: unknown;
}

export interface OkfDocument {
  /** Concept id = bundle-relative path without .md extension, posix separators. */
  id: string;
  frontmatter: OkfFrontmatter;
  body: string;
}

/** A raw parsed file: frontmatter may be absent (parse errors are surfaced separately). */
export interface RawDocument {
  id: string;
  /** null = no `---` opening line (whole file is body); false = opened but unterminated. */
  hasFrontmatter: boolean | null;
  frontmatter: OkfFrontmatter;
  body: string;
  parseError?: string;
}

export function parseDocument(text: string): { hasFrontmatter: boolean | null; frontmatter: OkfFrontmatter; body: string; parseError?: string } {
  if (!text.startsWith("---\n") && text !== "---" && !text.startsWith("---\r\n")) {
    return { hasFrontmatter: null, frontmatter: {}, body: text };
  }
  const firstLineEnd = text.indexOf("\n");
  const rest = text.slice(firstLineEnd + 1);
  // find closing --- on its own line
  const closeMatch = rest.match(/^(---|\.\.\.)\s*(\r?\n|$)/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { hasFrontmatter: false, frontmatter: {}, body: rest, parseError: "unterminated frontmatter block" };
  }
  const fmText = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length);
  let frontmatter: unknown;
  try {
    // yaml pkg defaults to YAML 1.2 core schema — ISO datetimes stay strings.
    frontmatter = parseYaml(fmText);
  } catch (err) {
    return { hasFrontmatter: true, frontmatter: {}, body, parseError: `invalid YAML: ${(err as Error).message}` };
  }
  if (frontmatter === null || frontmatter === undefined) {
    return { hasFrontmatter: true, frontmatter: {}, body };
  }
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return { hasFrontmatter: true, frontmatter: {}, body, parseError: "frontmatter is not a mapping" };
  }
  return { hasFrontmatter: true, frontmatter: frontmatter as OkfFrontmatter, body };
}

function orderFrontmatter(fm: OkfFrontmatter): OkfFrontmatter {
  const ordered: OkfFrontmatter = {};
  for (const key of KNOWN_KEY_ORDER) {
    if (key in fm) ordered[key] = fm[key];
  }
  for (const key of Object.keys(fm)) {
    if (!(key in ordered)) ordered[key] = fm[key];
  }
  return ordered;
}

export function serializeDocument(frontmatter: OkfFrontmatter, body: string, opts: { isIndex?: boolean } = {}): string {
  const fm = opts.isIndex ? frontmatter : orderFrontmatter(frontmatter);
  const y = stringifyYaml(fm, { sortMapEntries: false, lineWidth: 0 });
  return `---\n${y}---\n\n${body}`;
}

export interface VerifiedEvent {
  by: string;
  at: string;
}

/** Normalize `verified`: a bare mapping MUST be treated as a one-element list (SPEC §5.2). */
export function normalizeVerified(fm: OkfFrontmatter): VerifiedEvent[] {
  const v = fm["verified"];
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.filter((e): e is VerifiedEvent => typeof e === "object" && e !== null && !Array.isArray(e));
}

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export function trustTier(fm: OkfFrontmatter): TrustTier {
  const events = normalizeVerified(fm);
  if (events.length === 0) return "unverified";
  return events.some((e) => typeof e["by"] === "string" && e["by"].startsWith("human:"))
    ? "human-reviewed"
    : "machine-confirmed";
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Stale iff now >= stale_after, with a valid offset-bearing timestamp (date-only/naive → never stale, no error). */
export function isStale(fm: OkfFrontmatter, now: Date = new Date()): boolean {
  const sa = fm["stale_after"];
  if (typeof sa !== "string" || !ISO_WITH_OFFSET.test(sa)) return false;
  const t = Date.parse(sa);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= t;
}

export interface ValidationIssue {
  level: "error" | "warning" | "info";
  file: string;
  rule: string;
  message: string;
}

async function* walkMarkdown(dir: string, base: string = dir): AsyncGenerator<{ rel: string; abs: string }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(abs, base);
    } else if (entry.name.endsWith(".md")) {
      yield { rel: relative(base, abs).split(sep).join("/"), abs };
    }
  }
}

export interface Bundle {
  root: string;
  /** Concept documents only (reserved files excluded). */
  documents: OkfDocument[];
  /** Reserved + non-concept files by relative path. */
  reserved: { index: string[]; log: string[] };
}

export async function readBundle(root: string): Promise<Bundle> {
  const documents: OkfDocument[] = [];
  const reserved = { index: [] as string[], log: [] as string[] };
  for await (const { rel, abs } of walkMarkdown(root)) {
    if (rel === "index.md" || rel.endsWith("/index.md")) {
      reserved.index.push(rel);
      continue;
    }
    if (rel === "log.md" || rel.endsWith("/log.md")) {
      reserved.log.push(rel);
      continue;
    }
    const text = await readFile(abs, "utf8");
    const parsed = parseDocument(text);
    documents.push({ id: rel.replace(/\.md$/, ""), frontmatter: parsed.frontmatter, body: parsed.body });
  }
  return { root, documents, reserved };
}

const STATUS_VALUES = new Set(["draft", "stable", "deprecated"]);
const ACTOR_RE = /^(human:|process:)[^\s]+$|^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/;
const TIMESTAMP_KEYS = ["stale_after"];

function isOffsetTimestamp(value: unknown): boolean {
  return typeof value === "string" && ISO_WITH_OFFSET.test(value);
}

/** Validate a bundle per the official conformance matrix (knowledge/formats/okf-v02.md). */
export async function validateBundle(root: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const conceptIds = new Set<string>();

  for await (const { rel, abs } of walkMarkdown(root)) {
    const text = await readFile(abs, "utf8");

    if (rel.endsWith("/index.md") || rel === "index.md") {
      const parsed = parseDocument(text);
      if (rel === "index.md") {
        const keys = Object.keys(parsed.frontmatter);
        const bad = keys.filter((k) => k !== "okf_version");
        if (bad.length > 0) {
          issues.push({ level: "error", file: rel, rule: "index-frontmatter", message: `root index.md may only carry okf_version (found: ${bad.join(", ")})` });
        }
        const ver = parsed.frontmatter["okf_version"];
        if (ver !== undefined && ver !== OKF_VERSION && ver !== "0.1") {
          issues.push({ level: "warning", file: rel, rule: "okf-version", message: `unknown okf_version ${String(ver)}; consuming best-effort` });
        }
      } else if (Object.keys(parsed.frontmatter).length > 0) {
        issues.push({ level: "error", file: rel, rule: "index-frontmatter", message: "non-root index.md must not carry frontmatter" });
      }
      continue;
    }

    if (rel === "log.md" || rel.endsWith("/log.md")) {
      // frontmatter allowed in log.md (official sample carries type: Log)
      const dateHeadings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
      for (const h of dateHeadings) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(h)) continue;
        // allow a title heading (# ...) but any ## heading must be an ISO date
        issues.push({ level: "error", file: rel, rule: "log-dates", message: `## heading "${h}" is not ISO YYYY-MM-DD` });
      }
      continue;
    }

    conceptIds.add(rel.replace(/\.md$/, ""));
    const parsed = parseDocument(text);
    if (parsed.parseError) {
      issues.push({ level: "error", file: rel, rule: "frontmatter", message: parsed.parseError });
      continue;
    }
    if (parsed.hasFrontmatter === null) {
      issues.push({ level: "error", file: rel, rule: "frontmatter", message: "no YAML frontmatter block" });
      continue;
    }
    const fm = parsed.frontmatter;
    const type = fm["type"];
    if (typeof type !== "string" || type.trim() === "") {
      issues.push({ level: "error", file: rel, rule: "type-required", message: `type is ${type === undefined ? "missing" : "empty"} (type-only frontmatter is conformant)` });
      continue;
    }
    if (type === "Attested Computation") {
      if (typeof fm["runtime"] !== "string" || !fm["runtime"]) {
        issues.push({ level: "error", file: rel, rule: "ac-runtime", message: "type: Attested Computation requires runtime" });
      }
      const hasBodyComputation = /^#\s+Computation\b/m.test(parsed.body) && /```/.test(parsed.body);
      const hasPath = typeof fm["computation"] === "string" && fm["computation"] !== "";
      if (hasBodyComputation && hasPath) {
        issues.push({ level: "warning", file: rel, rule: "ac-computation", message: "both body # Computation block and computation: path" });
      } else if (!hasBodyComputation && !hasPath) {
        issues.push({ level: "warning", file: rel, rule: "ac-computation", message: "neither body # Computation block nor computation: path" });
      }
    }
    const status = fm["status"];
    if (status !== undefined && typeof status === "string" && !STATUS_VALUES.has(status)) {
      issues.push({ level: "warning", file: rel, rule: "status", message: `status "${status}" outside draft|stable|deprecated (absent = stable)` });
    }
    const generated = fm["generated"];
    if (generated !== undefined) {
      if (typeof generated !== "object" || generated === null || Array.isArray(generated) || typeof (generated as Record<string, unknown>)["by"] !== "string") {
        issues.push({ level: "warning", file: rel, rule: "generated-by", message: "generated present but generated.by missing/not a string" });
      }
      const at = (generated as Record<string, unknown>)["at"];
      if (at !== undefined && !isOffsetTimestamp(at)) {
        issues.push({ level: "warning", file: rel, rule: "generated-at", message: "generated.at not ISO 8601 with explicit UTC offset" });
      }
    }
    if ("timestamp" in fm) {
      issues.push({ level: "warning", file: rel, rule: "legacy-timestamp", message: "legacy v0.1 timestamp key; migrate to generated.at" });
    }
    if (/^#\s+Citations\b/m.test(parsed.body)) {
      issues.push({ level: "warning", file: rel, rule: "legacy-citations", message: "legacy v0.1 # Citations section; migrate to sources[]" });
    }
    const verified = fm["verified"];
    if (verified !== undefined) {
      for (const e of normalizeVerified(fm)) {
        if (typeof e["by"] !== "string" || typeof e["at"] !== "string") {
          issues.push({ level: "warning", file: rel, rule: "verified-shape", message: "verified entry missing by/at" });
        } else {
          if (!ACTOR_RE.test(e["by"])) {
            issues.push({ level: "warning", file: rel, rule: "verified-actor", message: `actor "${e["by"]}" not <producer>/<version> | human:<id> | process:<id>` });
          }
          if (!isOffsetTimestamp(e["at"])) {
            issues.push({ level: "warning", file: rel, rule: "verified-at", message: "verified.at not ISO 8601 with explicit UTC offset" });
          }
        }
      }
    }
    for (const key of TIMESTAMP_KEYS) {
      if (fm[key] !== undefined && !isOffsetTimestamp(fm[key])) {
        issues.push({ level: "warning", file: rel, rule: `${key}-format`, message: `${key} not ISO 8601 with explicit UTC offset (treated as not stale)` });
      }
    }
    const sources = fm["sources"];
    if (sources !== undefined) {
      const list = Array.isArray(sources) ? sources : [sources];
      const ids = new Set<string>();
      for (const s of list) {
        if (typeof s !== "object" || s === null || Array.isArray(s)) {
          issues.push({ level: "warning", file: rel, rule: "sources-entry", message: "non-mapping sources entry (dropped)" });
          continue;
        }
        const entry = s as Record<string, unknown>;
        if (entry["resource"] === undefined) {
          issues.push({ level: "warning", file: rel, rule: "sources-resource", message: "sources entry missing required resource" });
        }
        if (typeof entry["id"] === "string") {
          if (ids.has(entry["id"])) {
            issues.push({ level: "warning", file: rel, rule: "sources-dup-id", message: `duplicate sources id "${entry["id"]}"` });
          }
          ids.add(entry["id"]);
        }
      }
      // footnotes in body with no matching sources[].id
      for (const m of parsed.body.matchAll(/\[\^([^\]]+)\]/g)) {
        if (!ids.has(m[1]!)) {
          issues.push({ level: "warning", file: rel, rule: "footnote-orphan", message: `footnote [^${m[1]}] has no matching sources[].id` });
        }
      }
    }
    // broken internal links — tolerated, surfaced
    for (const m of parsed.body.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      const target = m[1]!;
      if (/^https?:|^mailto:/.test(target)) continue;
      const abs = target.startsWith("/")
        ? join(root, target)
        : join(root, dirname(rel), target);
      let ok = false;
      try {
        await stat(abs);
        ok = true;
      } catch {
        ok = false;
      }
      if (!ok) {
        issues.push({ level: "info", file: rel, rule: "link-broken", message: `broken internal link ${target} (tolerated)` });
      }
    }
    if (fm["title"] === undefined) {
      issues.push({ level: "info", file: rel, rule: "title-recommended", message: "recommended key title absent" });
    }
  }
  return issues;
}

/** Regenerate index.md per directory (official algorithm: deepest-first, # <Type> sections, sorted by title). */
export async function regenerateIndexes(root: string): Promise<string[]> {
  const written: string[] = [];
  const bundle = await readBundle(root);
  const byDir = new Map<string, OkfDocument[]>();
  for (const doc of bundle.documents) {
    const dir = dirname(doc.id) === "." ? "" : dirname(doc.id);
    const list = byDir.get(dir) ?? [];
    list.push(doc);
    byDir.set(dir, list);
  }
  const dirs = [...byDir.keys()].sort((a, b) => b.length - a.length); // deepest first
  for (const dir of dirs) {
    const docs = byDir.get(dir)!;
    const sections = new Map<string, OkfDocument[]>();
    for (const d of docs) {
      const type = String(d.frontmatter["type"] ?? "Unknown");
      const list = sections.get(type) ?? [];
      list.push(d);
      sections.set(type, list);
    }
    let body = "";
    const subdirs = new Set<string>();
    for (const d of docs) {
      const dir2 = dirname(d.id);
      if (dir2 !== dir) subdirs.add(dir2.slice(dir.length + 1));
    }
    if (dir === "" && subdirs.size > 0) {
      body += "# Subdirectories\n\n";
      for (const s of [...subdirs].sort()) {
        const childDocs = docs.filter((d) => dirname(d.id) === `${dir === "" ? "" : dir + "/"}${s}`);
        const desc =
          childDocs.length === 1
            ? String(childDocs[0]!.frontmatter["description"] ?? `Contains ${childDocs.length} entries.`)
            : String(childDocs[0]?.frontmatter["description"] ?? `Contains ${childDocs.length} entries: ${childDocs.map((d) => d.frontmatter["title"] ?? d.id).join(", ")}.`);
        body += `* [${s}](${s}/index.md) - ${desc}\n`;
      }
      body += "\n";
    }
    for (const [type, list] of sections) {
      body += `# ${type}\n\n`;
      const sorted = [...list].sort((a, b) =>
        String(a.frontmatter["title"] ?? a.id).localeCompare(String(b.frontmatter["title"] ?? b.id)),
      );
      for (const d of sorted) {
        const title = String(d.frontmatter["title"] ?? d.id);
        const desc = String(d.frontmatter["description"] ?? "");
        body += `* [${title}](${d.id.split("/").pop()}.md) - ${desc}\n`;
      }
      body += "\n";
    }
    const absDir = join(root, dir);
    await mkdir(absDir, { recursive: true });
    const isRoot = dir === "";
    const fm = isRoot ? { okf_version: OKF_VERSION } : {};
    const content = Object.keys(fm).length ? serializeDocument(fm, body, { isIndex: true }) : body.trimStart();
    await writeFile(join(absDir, "index.md"), content, "utf8");
    written.push(join(dir === "" ? "." : dir, "index.md").split(sep).join("/"));
  }
  return written;
}

/** Append a newest-first entry to log.md under today's ISO date. */
export async function appendLog(root: string, entry: string, now: Date = new Date()): Promise<void> {
  const date = now.toISOString().slice(0, 10);
  const logPath = join(root, "log.md");
  let text = "";
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    text = "# Change Log\n";
  }
  const heading = `## ${date}`;
  const idx = text.indexOf(heading);
  if (idx >= 0) {
    const insertAt = idx + heading.length;
    text = text.slice(0, insertAt) + `\n- ${entry}` + text.slice(insertAt);
  } else {
    // no section for today: insert right after the title line (newest first)
    const firstH2 = text.indexOf("\n## ");
    const block = `\n${heading}\n\n- ${entry}\n`;
    text = firstH2 >= 0 ? text.slice(0, firstH2 + 1) + block.trimEnd() + "\n" + text.slice(firstH2 + 1) : text.trimEnd() + "\n" + block;
  }
  await writeFile(logPath, text, "utf8");
}
