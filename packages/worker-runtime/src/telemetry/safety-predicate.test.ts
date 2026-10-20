/**
 * The safety-predicate guard.
 *
 * ── What it catches ────────────────────────────────────────────────────────
 *
 * A **safety predicate** is a function whose answer decides whether something
 * dangerous happens. `fallbackLegal` decides whether a task is run a second
 * time; `canFallback` decides the same thing one layer up.
 *
 * The defect PM-001 recorded was **not a bug in the predicate**. It was that
 * the predicate's decisive input was a **constant at every call site** — so
 * the predicate was structurally correct and structurally inert. The
 * predicate was tested; the *wiring* was not.
 *
 * Two guards, one structural and one textual:
 *
 * - **G1a — the decisive input is a REQUIRED argument.** A caller that
 *   forgets it cannot compile. This is the cure that actually landed, and
 *   the type-level assertion below is what keeps it landed.
 * - **G1b — no production call site passes a literal for the decisive
 *   input.** A hard-coded safety decision is the shape the original defect
 *   had, and it must not come back.
 *
 * ── Why the textual guard is narrow on purpose ─────────────────────────────
 *
 * It looks only at **non-test** files. A test that calls
 * `fallbackLegal({ effect: "NONE" })` is *asserting* the rule's answer, which
 * is exactly what a test is for. A production call site that does the same
 * thing has **hard-coded the decision**, and the decision was not that call
 * site's to make.
 *
 * It also does not forbid every literal. It forbids a literal **for the
 * decisive input** — the one value the predicate exists to reason about. A
 * constant *elsewhere* in the call is ordinary code.
 *
 * ── Where this lives, and why ───────────────────────────────────────────────
 *
 * In the kernel, because it needs the kernel's types, and the kernel is the
 * only package that may import them: `core` must not depend on the worker
 * runtime, and the package-boundary guard enforces that. The guard *reads*
 * the workspace's sources as data — the same way `repo-graph.test.ts` does —
 * so no module specifier crosses a package boundary.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { canFallback, fallbackLegal, type EffectState } from "./delegation.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/**
 * A safety predicate and the inputs that decide its answer.
 *
 * `decisive` is the 0-based index of the decisive argument.
 * `decisiveProperties` names the properties that carry the decision when the
 * decisive argument is an object literal.
 */
interface SafetyPredicate {
  readonly name: string;
  readonly decisive: number;
  readonly decisiveProperties?: readonly string[];
  /** Why this predicate is a safety predicate. Rendered in the failure. */
  readonly because: string;
}

const SAFETY_PREDICATES: readonly SafetyPredicate[] = [
  {
    name: "fallbackLegal",
    decisive: 0,
    decisiveProperties: ["effect", "committed"],
    because: "it decides whether a task that may have had an effect is run a second time",
  },
  {
    name: "canFallback",
    decisive: 2,
    because: "it decides whether the fallback chain advances after a failure",
  },
];

/** Every source file in the workspace, absolute, excluding tests. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === "research") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|mts)$/.test(entry)) continue;
      if (/\.(test|spec)\.[cm]?tsx?$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(REPO_ROOT);
  return out;
}

/**
 * Mask the source: comments and string *contents* become spaces.
 *
 * The mask preserves every offset, so a span found in the mask is the same
 * span in the original — which is what lets the guard find a call site
 * without matching text inside a string, and then read the call's argument
 * from the original.
 *
 * Without this, a doc comment that shows `fallbackLegal({ effect: "NONE" })`
 * would be reported as a hard-coded decision, and a guard that cries wolf
 * is a guard people learn to ignore.
 */
export function maskSource(source: string): string {
  const out = source.split("");
  let i = 0;
  let state: "code" | "line" | "block" | "string" | "template" = "code";
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        state = "line";
        continue;
      }
      if (ch === "/" && next === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        state = "block";
        continue;
      }
      if (ch === '"' || ch === "'") {
        state = "string";
        i += 1;
        continue;
      }
      if (ch === "`") {
        state = "template";
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") state = "code";
      else out[i] = " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        state = "code";
        continue;
      }
      if (ch !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    // Inside a string or template literal: keep the delimiters, mask the
    // contents, and honour the escape.
    if (ch === "\\") {
      out[i] = " ";
      if (i + 1 < source.length) out[i + 1] = " ";
      i += 2;
      continue;
    }
    if ((state === "string" && ch === '"') || (state === "template" && ch === "`")) {
      state = "code";
      i += 1;
      continue;
    }
    if (ch !== "\n") out[i] = " ";
    i += 1;
  }
  return out.join("");
}

/** The span of a call's argument list, in the masked source. */
function argumentSpan(mask: string, openParen: number): { start: number; end: number } {
  let depth = 0;
  for (let i = openParen; i < mask.length; i++) {
    const ch = mask[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { start: openParen + 1, end: i };
    }
  }
  return { start: openParen + 1, end: mask.length };
}

/** Split a masked argument list on its top-level commas. */
function splitMaskedArguments(mask: string, start: number, end: number): Array<{ start: number; end: number }> {
  const parts: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let partStart = start;
  for (let i = start; i < end; i++) {
    const ch = mask[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push({ start: partStart, end: i });
      partStart = i + 1;
    }
  }
  if (mask.slice(partStart, end).trim() !== "") parts.push({ start: partStart, end });
  return parts;
}

/** The span of a property's value inside an object literal, in the mask. */
function propertySpan(mask: string, start: number, end: number, property: string): { start: number; end: number } | null {
  const text = mask.slice(start, end);
  const match = new RegExp(`(?:^|[{,\\s])${property}\\s*:`, "m").exec(text);
  if (!match) return null;
  const valueStart = start + match.index + match[0].length;
  let depth = 0;
  for (let i = valueStart; i < end; i++) {
    const ch = mask[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return { start: valueStart, end: i };
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return { start: valueStart, end: i };
    }
  }
  return { start: valueStart, end };
}

/** Is this text a hard-coded value? */
export function isLiteral(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  if (/^["'`]/.test(t)) return true;
  if (/^(true|false|null|undefined)$/.test(t)) return true;
  if (/^-?\d+(\.\d+)?$/.test(t)) return true;
  return false;
}

/**
 * The hard-coded decisive inputs in one source file.
 *
 * Returns one message per offending call site.
 */
export function hardCodedSafetyInputs(source: string, file: string): string[] {
  const mask = maskSource(source);
  const found: string[] = [];
  for (const predicate of SAFETY_PREDICATES) {
    const pattern = new RegExp(`\\b${predicate.name}\\s*\\(`, "g");
    for (const match of mask.matchAll(pattern)) {
      const openParen = mask.indexOf("(", match.index);
      const args = splitMaskedArguments(mask, ...Object.values(argumentSpan(mask, openParen)) as [number, number]);
      const decisive = args[predicate.decisive];
      if (!decisive) continue;

      const properties = predicate.decisiveProperties ?? [];
      if (properties.length > 0 && mask.slice(decisive.start, decisive.end).trim().startsWith("{")) {
        for (const property of properties) {
          const span = propertySpan(mask, decisive.start, decisive.end, property);
          if (!span) continue;
          const value = source.slice(span.start, span.end).trim();
          if (!isLiteral(value)) continue;
          found.push(
            `${file}: ${predicate.name}() is called with a HARD-CODED ${property} (${value}) — it ${predicate.because}, ` +
              `and a constant decision is the shape PM-001 recorded`,
          );
        }
        continue;
      }

      const value = source.slice(decisive.start, decisive.end).trim();
      if (!isLiteral(value)) continue;
      found.push(
        `${file}: ${predicate.name}() is called with a HARD-CODED argument ${predicate.decisive} (${value}) — it ` +
          `${predicate.because}, and a constant decision is the shape PM-001 recorded`,
      );
    }
  }
  return found;
}

describe("the safety-predicate guard", () => {
  it("has production sources to scan — the guard is not vacuous", () => {
    const sources = productionSources();
    expect(sources.length, "no production sources were found").toBeGreaterThan(5);
  });

  it("finds no hard-coded decisive input in any production call site", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      offenders.push(...hardCodedSafetyInputs(readFileSync(file, "utf8"), relative(REPO_ROOT, file)));
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("CAN fail — a hard-coded effect state is caught", () => {
    // The guard's own mutation test. A guard that cannot fail is not
    // evidence, and this is the difference between a check and a promise.
    const offender = `
      const ok = fallbackLegal({ committed: false, effect: "NONE" });
    `;
    const found = hardCodedSafetyInputs(offender, "synthetic.ts");
    // BOTH decisive inputs are hard-coded here, and both are reported.
    expect(found.length, "both hard-coded inputs must be caught").toBe(2);
    expect(found[0]).toContain("HARD-CODED");
    expect(found.some((f) => f.includes("effect"))).toBe(true);
    expect(found.some((f) => f.includes("committed"))).toBe(true);
  });

  it("CAN fail — a hard-coded committed flag is caught", () => {
    // The exact shape PM-001 recorded.
    const offender = `
      const ok = fallbackLegal({ committed: false, effect: state.effect });
    `;
    const found = hardCodedSafetyInputs(offender, "synthetic.ts");
    expect(found.length, "a hard-coded committed flag must be caught").toBe(1);
    expect(found[0]).toContain("committed");
  });

  it("CAN fail — a hard-coded effect state passed to canFallback is caught", () => {
    const offender = `
      const ok = canFallback(observation, failureClass, "NONE");
    `;
    const found = hardCodedSafetyInputs(offender, "synthetic.ts");
    expect(found.length, "a hard-coded effect state must be caught").toBe(1);
  });

  it("does not flag a comment, a string, or a computed value", () => {
    const clean = `
      // fallbackLegal({ effect: "NONE" }) is what the kernel does.
      const note = 'fallbackLegal({ effect: "NONE" })';
      const ok = fallbackLegal({ committed: observation.committed ?? false, effect });
      const also = canFallback(observation, failureClass, effectState);
    `;
    expect(hardCodedSafetyInputs(clean, "synthetic.ts")).toEqual([]);
  });
});

describe("the decisive input is required", () => {
  // A COMPILE-TIME assertion. If the decisive argument ever becomes
  // optional, this file stops compiling — which is the whole point: a
  // forgotten effect state must not be expressible.
  type CanFallbackArgs = Parameters<typeof canFallback>;
  type EffectArg = CanFallbackArgs[2];
  type IsRequired = undefined extends EffectArg ? false : true;
  const effectArgIsRequired: IsRequired = true;
  expect(effectArgIsRequired).toBe(true);

  type FallbackArgs = Parameters<typeof fallbackLegal>;
  type FallbackEffect = FallbackArgs[0]["effect"];
  type FallbackEffectRequired = undefined extends FallbackEffect ? false : true;
  const fallbackEffectIsRequired: FallbackEffectRequired = true;
  expect(fallbackEffectIsRequired).toBe(true);

  it("declares the effect state as a first-class value, not an omission", () => {
    // `UNKNOWN` is the honest answer for a wrapper that cannot observe
    // effects, so it has to be spellable.
    const unknown: EffectState = "UNKNOWN";
    expect(unknown).toBe("UNKNOWN");
    expect(fallbackLegal({ effect: unknown })).toBe(false);
  });
});
