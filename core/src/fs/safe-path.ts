import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

/**
 * SafePath boundary (spec CORE-INVARIANTS-V2 §1.1). The ONE way untrusted
 * input becomes a filesystem path in this codebase. Lexical rejection first,
 * then two-sided realpath containment. Failure is always a thrown SecurityError
 * — never a partial action, never a fallback.
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

const MAX_INPUT = 4096;
const MAX_SEGMENT = 255;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Lexical validation of an untrusted RELATIVE path. Returns the normalized
 * posix form, or throws SecurityError. Does not touch the filesystem.
 * Rejected: empty, >4096 bytes, NUL/control chars, absolute paths (posix,
 * windows drive-letter, UNC), any `..` segment after normalization, backslash
 * separators on posix, segments >255 bytes.
 */
export function assertSafeRelative(input: string, what = "relative path"): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new SecurityError(`unsafe ${what}: empty input`);
  }
  if (input.length > MAX_INPUT) {
    throw new SecurityError(`unsafe ${what}: longer than ${MAX_INPUT} bytes`);
  }
  if (input.includes("\0")) {
    throw new SecurityError(`unsafe ${what}: NUL byte`);
  }
  if (isAbsolute(input)) {
    throw new SecurityError(`unsafe ${what}: absolute path ${JSON.stringify(input)}`);
  }
  if (/^[A-Za-z]:/u.test(input) || input.startsWith("\\\\") || input.startsWith("//")) {
    throw new SecurityError(`unsafe ${what}: drive/UNC path ${JSON.stringify(input)}`);
  }
  if (sep === "/" && input.includes("\\")) {
    throw new SecurityError(`unsafe ${what}: backslash separator on posix ${JSON.stringify(input)}`);
  }
  const segments: string[] = [];
  for (const raw of input.split(/[\\/]+/u)) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      throw new SecurityError(`unsafe ${what}: traversal segment in ${JSON.stringify(input)}`);
    }
    if (raw.length > MAX_SEGMENT) {
      throw new SecurityError(`unsafe ${what}: segment longer than ${MAX_SEGMENT} bytes`);
    }
    if (/^[A-Za-z]:/u.test(raw)) {
      throw new SecurityError(`unsafe ${what}: drive-letter segment ${JSON.stringify(input)}`);
    }
    if (CONTROL_CHARS.test(raw)) {
      throw new SecurityError(`unsafe ${what}: control characters in ${JSON.stringify(input)}`);
    }
    segments.push(raw);
  }
  if (segments.length === 0) {
    throw new SecurityError(`unsafe ${what}: resolves to the authorized root itself ${JSON.stringify(input)}`);
  }
  return segments.join("/");
}

/** True iff `candidate` is `root` itself or lies strictly inside `root`. */
export function isContained(candidate: string, root: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (norm(candidate) === norm(root)) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return norm(candidate).startsWith(norm(withSep));
}

async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** True when a directory entry exists (lstat follows nothing — dangling links count as existing). */
async function entryExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an untrusted relative path against an authorized root with full
 * symlink containment (spec §1.1): realpath BOTH sides; the candidate's
 * deepest existing ancestor must already be inside the (real) root; any
 * not-yet-existing tail is admissible only below that trusted ancestor.
 * Returns the LEXICAL candidate (same root form the caller passed) — the
 * realpath walk proves containment of every existing segment, so no
 * short-path/8.3 form drift leaks into the result.
 */
export async function resolveAuthorizedPath(authorizedRoot: string, untrustedInput: string): Promise<string> {
  const rel = assertSafeRelative(untrustedInput);
  const rootReal = await tryRealpath(resolve(authorizedRoot));
  if (rootReal === null) {
    throw new SecurityError(`unsafe path: authorized root does not exist: ${authorizedRoot}`);
  }
  const candidate = resolve(authorizedRoot, rel);

  // walk up to the deepest EXISTING ancestor; everything below it cannot
  // contain symlinks (it does not exist yet)
  let probe = candidate;
  for (;;) {
    const probed = await tryRealpath(probe);
    if (probed !== null) {
      if (!isContained(probed, rootReal)) {
        throw new SecurityError(`path escape detected: ${JSON.stringify(untrustedInput)} resolves outside the authorized root ${authorizedRoot}`);
      }
      return candidate;
    }
    // realpath failed but the entry EXISTS ⇒ a link whose target is missing
    // (or unreadable). Its target may live outside the root, and a writer
    // would follow it — refuse instead of treating it as "not existing".
    if (await entryExists(probe)) {
      throw new SecurityError(`path escape detected: ${JSON.stringify(untrustedInput)} passes through an unresolvable link (${probe})`);
    }
    if (probe === parse(probe).root || probe.length <= 2) {
      throw new SecurityError(`unsafe path: authorized root does not exist: ${authorizedRoot}`);
    }
    const idx = probe.lastIndexOf(sep);
    if (idx < 0) {
      throw new SecurityError(`unsafe path: cannot resolve ${JSON.stringify(untrustedInput)} under ${authorizedRoot}`);
    }
    probe = probe.slice(0, idx);
  }
}
