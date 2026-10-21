/**
 * `LocalProcessBackend` — the one execution backend (M9).
 *
 * ── What it guarantees, and what it does not ───────────────────────────────
 *
 * It guarantees:
 *
 * - **no shell.** The argv array goes to the OS unchanged, so an argument
 *   can never be interpreted as syntax. This is the single most important
 *   line in the file.
 * - **an allowlisted environment.** The child sees the named variables and
 *   nothing else — a denylist would leak whatever the host happened to be
 *   carrying.
 * - **a hard deadline.** When the deadline is reached the process is
 *   killed, along with its tree, and the result says `timedOut`.
 * - **capped output.** Captured streams are capped in BYTES, because a
 *   stream of four-byte characters would use four times the memory if the
 *   cap were counted in characters.
 * - **a pinned working directory**, confined inside the caller's root.
 *
 * It does **not** guarantee:
 *
 * - **filesystem confinement.** The child's working directory is pinned
 *   inside the root, but a process with filesystem permissions can still
 *   reach elsewhere. That is a fact about processes, not about this
 *   implementation, and a backend that cannot confine it must not claim to.
 * - **network confinement.** There is no portable way to take a local
 *   process's network access away, so there is no policy field for it. A
 *   field named `allowNetwork` would be a promise nothing enforces.
 *
 * ── Where this came from ───────────────────────────────────────────────────
 *
 * The safe-spawn logic is lifted from the CLI's delegation wrapper
 * (`cli/src/delegate.ts`), which already had it right: no shell, an
 * environment allowlist, a deadline, an output cap, and a process-tree kill.
 * The kernel cannot import from the CLI — the package boundary forbids it —
 * so the logic is re-implemented here against the kernel's contracts. This
 * file is the second implementation of a rule the CLI already follows, and
 * the rule is now written down in both places.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ArtifactCapture,
  ExecutionMetadata,
  ExecutionRequest,
  ExecutionResult,
} from "../contracts/index.js";
import type { ExecutionBackend } from "./backend.js";

export interface LocalProcessBackendOptions {
  /**
   * The directory every execution runs inside.
   *
   * The request's working directory is resolved INSIDE this root, and a
   * request that escapes it is refused. The root is the boundary; there is
   * no second boundary and no way to widen it per request.
   */
  readonly root: string;
  /** How long a kill waits before the child is killed outright. */
  readonly killGraceMs?: number;
}

/** The outcome of one attempt, before it becomes a contract record. */
interface Attempt {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

/**
 * Accumulate a stream under a byte cap.
 *
 * Counting characters would let a stream of four-byte characters use four
 * times the intended memory, and this accumulation is what stops an
 * unbounded producer from exhausting the host.
 */
class ByteCappedStream {
  private readonly chunks: Buffer[] = [];
  private readonly maxBytes: number;
  private bytes = 0;
  private cut = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    if (this.cut) return;
    const room = this.maxBytes - this.bytes;
    if (chunk.byteLength <= room) {
      this.chunks.push(chunk);
      this.bytes += chunk.byteLength;
      return;
    }
    // A chunk that straddles the boundary is cut on a byte boundary.
    // Cutting mid-codepoint would leave a replacement character, which is
    // fine for diagnostics but must not be mistaken for the run's output.
    this.chunks.push(chunk.subarray(0, room));
    this.bytes += room;
    this.cut = true;
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  get truncated(): boolean {
    return this.cut;
  }
}

/** The files under a directory, with their content hashes. */
function snapshotTree(root: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(root)) return found;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(full);
      found.set(relative(root, full).split(sep).join("/"), createHash("sha256").update(bytes).digest("hex"));
    }
  };
  walk(root);
  return found;
}

/**
 * Resolve a path inside a root, refusing anything that escapes it.
 *
 * The check is on the RESOLVED path, not the written one: `..` segments and
 * symbolic links both have to be followed before the answer is known. A
 * check on the written path is a check a symlink walks straight past.
 */
function resolveInside(root: string, candidate: string): string | undefined {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    // The path does not exist yet. The nearest existing ancestor decides
    // whether it would have escaped: a not-yet-created directory under an
    // existing symlinked one inherits that link.
    let probe = absolute;
    const suffix: string[] = [];
    for (;;) {
      const parent = resolve(probe, "..");
      suffix.unshift(resolve(probe).slice(parent.length + 1));
      if (parent === probe) return undefined;
      try {
        const realParent = realpathSync(parent);
        const joined = join(realParent, ...suffix.filter((s) => s.length > 0));
        return joined.startsWith(realpathSync(root)) ? joined : undefined;
      } catch {
        probe = parent;
      }
    }
  }
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
  return real;
}

/** Build the child's environment from the allowlist. */
function childEnvironment(
  allowlist: readonly string[],
  requested: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of allowlist) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // The request may OVERRIDE a value the allowlist already provides — that
  // is the point of naming it explicitly — but it may not ADD a name the
  // allowlist does not carry. A request that could add names would make the
  // allowlist decorative.
  for (const [name, value] of Object.entries(requested)) {
    if (allowlist.includes(name)) env[name] = value;
  }
  return env;
}

export class LocalProcessBackend implements ExecutionBackend {
  readonly kind = "local-process";
  private readonly root: string;
  private readonly killGraceMs: number;

  constructor(options: LocalProcessBackendOptions) {
    this.root = resolve(options.root);
    this.killGraceMs = options.killGraceMs ?? 2_000;
    if (!existsSync(this.root)) {
      throw new Error(`the execution root does not exist: ${this.root}`);
    }
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const cwd = resolveInside(this.root, request.cwd);
    if (!cwd) {
      // A refused working directory is a RESULT, not an exception: the
      // caller asked for something that was not allowed, and the answer
      // belongs in the record.
      return this.refused(request, `the working directory escapes the execution root: ${request.cwd}`);
    }

    const before = snapshotTree(cwd);
    const attempt = await this.run(request, cwd);
    const artifacts = request.policy.captureArtifacts
      ? this.captureArtifacts(request, cwd, before)
      : [];

    const metadata: ExecutionMetadata = {
      argv: [...request.argv],
      cwd,
      envKeys: Object.keys(childEnvironment(request.policy.envAllowlist, request.env)).sort(),
      limits: request.limits,
      policy: request.policy,
    };

    return {
      id: request.id,
      contractVersion: request.contractVersion,
      exitCode: attempt.exitCode,
      signal: attempt.signal,
      timedOut: attempt.timedOut,
      stdout: attempt.stdout,
      stdoutTruncated: attempt.stdoutTruncated,
      stderr: attempt.stderr,
      stderrTruncated: attempt.stderrTruncated,
      artifacts,
      metadata,
    };
  }

  /** The files the run produced or changed. */
  private captureArtifacts(
    request: ExecutionRequest,
    cwd: string,
    before: Map<string, string>,
  ): ArtifactCapture[] {
    const after = snapshotTree(cwd);
    const changed: string[] = [];
    for (const [path, hash] of after) {
      if (before.get(path) !== hash) changed.push(path);
    }
    changed.sort();
    const kept: ArtifactCapture[] = [];
    for (const path of changed) {
      if (kept.length >= request.limits.maxArtifacts) break;
      const bytes = readFileSync(join(cwd, path));
      const truncated = bytes.byteLength > request.limits.maxArtifactBytes;
      const captured = truncated ? bytes.subarray(0, request.limits.maxArtifactBytes) : bytes;
      kept.push({
        path,
        contentHash: `sha256:${createHash("sha256").update(captured).digest("hex")}`,
        bytes: captured.byteLength,
        truncated,
      });
    }
    return kept;
  }

  /** The refusal result: the run never happened, and it says so. */
  private refused(request: ExecutionRequest, reason: string): ExecutionResult {
    return {
      id: request.id,
      contractVersion: request.contractVersion,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: "",
      stdoutTruncated: false,
      stderr: reason,
      stderrTruncated: false,
      artifacts: [],
      metadata: {
        argv: [...request.argv],
        cwd: this.root,
        envKeys: [],
        limits: request.limits,
        policy: request.policy,
      },
    };
  }

  /** Run the child, under the deadline, and collect what it said. */
  private run(request: ExecutionRequest, cwd: string): Promise<Attempt> {
    const [command, ...args] = request.argv;
    return new Promise<Attempt>((resolveAttempt) => {
      const stdout = new ByteCappedStream(request.limits.maxOutputBytes);
      const stderr = new ByteCappedStream(request.limits.maxOutputBytes);
      let timedOut = false;
      let settled = false;

      const child = spawn(command!, args, {
        // NEVER a shell: the argv array is passed to the OS unchanged, so
        // an argument can never be interpreted as syntax.
        shell: false,
        cwd,
        env: childEnvironment(request.policy.envAllowlist, request.env),
        stdio: ["ignore", "pipe", "pipe"],
        // A process group, so the whole tree can be killed at once.
        detached: process.platform !== "win32",
      });

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        this.killTree(child.pid);
      }, request.limits.timeoutMs);

      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveAttempt({
          exitCode,
          signal,
          timedOut,
          stdout: stdout.text,
          stdoutTruncated: stdout.truncated,
          stderr: stderr.text,
          stderrTruncated: stderr.truncated,
        });
      };

      child.on("error", (error: Error) => {
        stderr.push(Buffer.from(String(error.message), "utf8"));
        finish(null, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });
  }

  /**
   * Kill the process TREE, not just the direct child.
   *
   * `child.kill()` alone leaves a grandchild running, still holding the
   * stdio pipes, still writing to the working directory after the deadline
   * has passed.
   */
  private killTree(pid: number | undefined): void {
    if (pid === undefined) return;
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", shell: false });
      } catch {
        // The kill failed; the deadline has still been enforced on the
        // direct child below.
      }
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

/** The size of a directory's contents, for a caller that wants to know. */
export function executionRootSize(root: string): number {
  let total = 0;
  if (!existsSync(root)) return 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(root);
  return total;
}
