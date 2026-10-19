/**
 * A YAML 1.2 core-schema parser for the subset OKF frontmatter uses.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The MCP server is dependency-free by contract: an emitted bundle must run
 * without `node_modules`. It therefore cannot use the `yaml` package the CLI
 * uses, and the hand-rolled parser it used to ship was NOT YAML — it silently
 * produced the wrong shape for real OKF frontmatter:
 *
 *   - `tags: [a, b]`      → the string "[a, b]" (tags were dropped entirely)
 *   - `verified: []`      → the string "[]" (trust tier computed wrongly)
 *   - `generated:` + nest → the empty array [] (nested map dropped)
 *   - `sources:` + `- …`  → a list of mangled strings (ids and titles lost)
 *
 * Those are not cosmetic differences: the MCP tools report `tags` and `trust`,
 * so the server was reporting facts about the bundle that were simply false.
 *
 * This parser implements the core schema (the same one `yaml` uses by default)
 * over the block/flow constructs OKF frontmatter actually contains. It is
 * proven equivalent to the `yaml` package by a differential test that parses
 * every file of the real knowledge bundle with both and compares the results.
 *
 * Supported:
 *   - block mappings (nested by indentation)
 *   - block sequences (scalars, and mappings that start on the dash line)
 *   - flow sequences `[a, b]` and flow mappings `{a: 1}`
 *   - plain, single-quoted and double-quoted scalars
 *   - literal (`|`) and folded (`>`) block scalars
 *   - `#` comments outside quotes
 *   - core-schema typing: true/false → boolean, null/~ → null, numbers → number
 */

const BLANK_OR_COMMENT = (line) => {
  const t = line.trim();
  return t === "" || t.startsWith("#");
};

/** Indentation width and trimmed content of a line. */
function splitLine(line) {
  return { indent: line.length - line.trimStart().length, text: line.trim() };
}

/**
 * Remove a trailing `#` comment.
 * A `#` only starts a comment when it is at the start of the content or
 * preceded by whitespace, and never inside quotes.
 */
function stripComment(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text;
}

/** Unescape a double-quoted scalar body. */
function unescapeDouble(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[++i];
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "0": out += "\0"; break;
      case "a": out += "\x07"; break;
      case "e": out += "\x1b"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      case " ": out += " "; break;
      case "x": {
        const hex = body.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else {
          out += "x";
        }
        break;
      }
      case "u": {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += "u";
        }
        break;
      }
      default:
        out += next === undefined ? "\\" : next;
    }
  }
  return out;
}

/** Split a flow collection body on top-level commas. */
function splitFlow(text) {
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inSingle) {
      current += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += c;
      if (c === "\\") {
        current += text[++i] ?? "";
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; current += c; continue; }
    if (c === '"') { inDouble = true; current += c; continue; }
    if (c === "[" || c === "{") { depth++; current += c; continue; }
    if (c === "]" || c === "}") { depth--; current += c; continue; }
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "" || parts.length > 0) parts.push(current);
  return parts;
}

/** Core-schema scalar resolution. */
function parseScalar(text) {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeDouble(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlow(inner).map((p) => parseScalar(p.trim()));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    const out = {};
    if (inner === "") return out;
    for (const part of splitFlow(inner)) {
      const entry = part.trim();
      if (entry === "") continue;
      const colon = findFlowKeyColon(entry);
      if (colon < 0) {
        out[parseScalar(entry)] = null;
        continue;
      }
      out[String(parseScalar(entry.slice(0, colon)))] = parseScalar(entry.slice(colon + 1));
    }
    return out;
  }

  // YAML 1.2 core schema: only true/false are booleans (yes/no/on/off stay strings).
  if (trimmed === "null" || trimmed === "Null" || trimmed === "NULL" || trimmed === "~") return null;
  if (trimmed === "true" || trimmed === "True" || trimmed === "TRUE") return true;
  if (trimmed === "false" || trimmed === "False" || trimmed === "FALSE") return false;
  if (/^[-+]?[0-9]+$/.test(trimmed)) return Number(trimmed);
  if (/^0o[0-7]+$/.test(trimmed)) return parseInt(trimmed.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed.slice(2), 16);
  if (/^[-+]?([0-9]+\.[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$/.test(trimmed)) return Number(trimmed);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(trimmed)) return trimmed.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(trimmed)) return NaN;

  return trimmed;
}

/** Index of the `:` that separates a flow-mapping key from its value. */
function findFlowKeyColon(entry) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === "\\") { i++; continue; } if (c === '"') inDouble = false; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === ":" && (i + 1 === entry.length || /\s/.test(entry[i + 1]))) return i;
  }
  return -1;
}

/**
 * Recognize `key: value` / `key:` at the start of a line.
 * Returns null when the line is not a mapping entry.
 */
function matchKey(text) {
  if (text.startsWith("- ") || text === "-") return null;
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === "\\") { i++; continue; } if (c === '"') inDouble = false; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "[" || c === "{") { depth++; continue; }
    if (c === "]" || c === "}") { depth--; continue; }
    if (c === ":" && depth === 0) {
      const after = text[i + 1];
      if (after === undefined || after === " " || after === "\t") {
        const rawKey = text.slice(0, i).trim();
        if (rawKey === "") return null;
        const rest = after === undefined ? "" : stripComment(text.slice(i + 1)).trim();
        return { key: String(parseScalar(rawKey)), rest };
      }
    }
  }
  return null;
}

/** Skip blank and comment-only lines. */
function skipIgnorable(state) {
  while (state.i < state.lines.length && BLANK_OR_COMMENT(state.lines[state.i])) state.i++;
}

/** Parse a literal (`|`) or folded (`>`) block scalar. */
function parseBlockScalar(header, state, parentIndent) {
  const folded = header[0] === ">";
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  const collected = [];
  let blockIndent = null;

  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.trim() === "") {
      collected.push("");
      state.i++;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = indent;
    collected.push(line.slice(Math.min(blockIndent, indent)));
    state.i++;
  }

  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();

  let text;
  if (folded) {
    let out = "";
    for (let i = 0; i < collected.length; i++) {
      const l = collected[i];
      if (l === "") {
        out += "\n";
        continue;
      }
      if (i > 0 && collected[i - 1] !== "" && !out.endsWith("\n")) out += " ";
      out += l;
    }
    text = out;
  } else {
    text = collected.join("\n");
  }

  if (chomp === "clip" && text !== "") text += "\n";
  else if (chomp === "keep") text += "\n";
  return text;
}

/** Parse a value that appears on the same line as its key (or dash). */
function parseInlineValue(text, state, indent) {
  if (text === "|" || text === ">" || /^[|>][-+]?$/.test(text)) {
    return parseBlockScalar(text, state, indent);
  }
  return parseScalar(text);
}

/** Parse a block (mapping or sequence) whose content is at `minIndent` or deeper. */
function parseBlock(state, minIndent) {
  skipIgnorable(state);
  if (state.i >= state.lines.length) return null;
  const { indent, text } = splitLine(state.lines[state.i]);
  if (indent < minIndent) return null;
  if (text === "-" || text.startsWith("- ")) return parseSequence(state, indent);
  return parseMapping(state, indent);
}

/** Parse a block sequence. */
function parseSequence(state, indent) {
  const items = [];
  for (;;) {
    skipIgnorable(state);
    if (state.i >= state.lines.length) break;
    const { indent: ind, text } = splitLine(state.lines[state.i]);
    if (ind < indent) break;
    if (ind > indent) {
      state.i++;
      continue;
    }
    if (!(text === "-" || text.startsWith("- "))) break;

    const rest = text === "-" ? "" : stripComment(text.slice(2)).trim();
    state.i++;
    if (rest === "") {
      items.push(parseBlock(state, indent + 1));
      continue;
    }

    // A mapping may start on the dash line: `- key: value`.
    const key = matchKey(rest);
    if (key) {
      const map = {};
      if (key.rest === "") {
        map[key.key] = parseBlock(state, indent + 3);
      } else {
        map[key.key] = parseInlineValue(key.rest, state, indent + 2);
      }
      // Continuation lines of this mapping are indented to the key's column.
      parseMappingEntries(state, indent + 2, map);
      items.push(map);
      continue;
    }

    items.push(parseInlineValue(rest, state, indent + 1));
  }
  return items;
}

/** Parse a block mapping. */
function parseMapping(state, indent) {
  const map = {};
  parseMappingEntries(state, indent, map);
  return map;
}

/** Parse mapping entries at exactly `indent`, merging into `map`. */
function parseMappingEntries(state, indent, map) {
  for (;;) {
    skipIgnorable(state);
    if (state.i >= state.lines.length) break;
    const { indent: ind, text } = splitLine(state.lines[state.i]);
    if (ind < indent) break;
    if (ind > indent) {
      // Stray over-indented line with no owning key — skip it rather than
      // corrupting the surrounding mapping.
      state.i++;
      continue;
    }
    if (text === "-" || text.startsWith("- ")) break; // a sequence ends this mapping
    const entry = matchKey(text);
    if (!entry) {
      state.i++;
      continue;
    }
    state.i++;
    if (entry.rest === "") {
      map[entry.key] = parseBlock(state, indent + 1);
    } else {
      map[entry.key] = parseInlineValue(entry.rest, state, indent);
    }
  }
  return map;
}

/**
 * Parse a YAML document.
 * Returns the parsed value; an empty document yields null.
 */
export function parseYaml(source) {
  const text = String(source ?? "");
  // A leading document marker is optional and carries no information.
  const normalized = text.replace(/^﻿/, "").replace(/^(---|\.\.\.)[ \t]*\r?\n/, "");
  const state = { lines: normalized.split(/\r?\n/), i: 0 };
  const value = parseBlock(state, 0);
  return value === undefined ? null : value;
}

export default parseYaml;
