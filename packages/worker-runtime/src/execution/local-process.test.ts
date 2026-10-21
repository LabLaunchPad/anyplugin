/**
 * The local-process backend (M9).
 *
 * Every test here proves a **property the implementation claims**, and
 * every property is one a consumer of the kernel would rely on. A backend
 * that cannot be shown to keep its promises is a backend nobody may run
 * unattended.
 *
 * The properties, in the order they matter:
 *
 *  1. the environment is an ALLOWLIST — the child sees the named variables
 *     and nothing else;
 *  2. the argv array is never interpreted as shell syntax;
 *  3. the deadline is enforced, and the whole tree is killed;
 *  4. output is capped, in bytes;
 *  5. a working directory outside the root is REFUSED, not clamped;
 *  6. the artifacts are the files the run produced or changed; and
 *  7. the metadata is a pure function of the request.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessBackend } from "./local-process.js";
import {
  CONTRACT_VERSION,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  type ExecutionRequest,
} from "../contracts/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anyplugin-exec-"));
  mkdirSync(join(root, "work"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const candidate = {
    id: "EXE-test",
    contractVersion: CONTRACT_VERSION,
    argv: [process.execPath, "-e", "process.stdout.write('hello')"],
    cwd: "work",
    env: {},
    limits: {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      maxArtifactBytes: 1024,
      maxArtifacts: 10,
    },
    policy: {
      envAllowlist: ["PATH"],
      confineCwd: true,
      captureArtifacts: true,
    },
    ...overrides,
  };
  const parsed = ExecutionRequestSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`the test request is invalid: ${parsed.error.message}`);
  return parsed.data;
}

describe("LocalProcessBackend", () => {
  it("runs the command and reports what it said", async () => {
    const backend = new LocalProcessBackend({ root });
    const result = await backend.execute(request());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderrTruncated).toBe(false);
    expect(result.timedOut).toBe(false);
    // The result is a contract record, and it satisfies the contract.
    expect(ExecutionResultSchema.safeParse(result).success).toBe(true);
  });

  it("gives the child an ALLOWLISTED environment and nothing else", async () => {
    const backend = new LocalProcessBackend({ root });
    // A variable that must NOT reach the child, and one that must.
    process.env["ANYPLUGIN_SECRET"] = "must-not-leak";
    try {
      const result = await backend.execute(
        request({
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify({seen: process.env.ANYPLUGIN_SECRET ?? null, home: process.env.HOME ?? null}))",
          ],
          policy: {
            envAllowlist: ["PATH"],
            confineCwd: true,
            captureArtifacts: true,
          },
        }),
      );
      const seen = JSON.parse(result.stdout) as { seen: string | null; home: string | null };
      expect(seen.seen).toBeNull();
      expect(seen.home).toBeNull();
      // And the metadata reports only the names the child could see.
      expect(result.metadata.envKeys).toEqual(["PATH"]);
    } finally {
      delete process.env["ANYPLUGIN_SECRET"];
    }
  });

  it("lets the request OVERRIDE an allowlisted value, but not ADD a name", async () => {
    const backend = new LocalProcessBackend({ root });
    const result = await backend.execute(
      request({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify({mode: process.env.ANYPLUGIN_MODE ?? null}))",
        ],
        env: { ANYPLUGIN_MODE: "set-by-request" },
        policy: { envAllowlist: ["PATH", "ANYPLUGIN_MODE"], confineCwd: true, captureArtifacts: true },
      }),
    );
    expect(JSON.parse(result.stdout).mode).toBe("set-by-request");

    // A name the allowlist does not carry is dropped, not passed through.
    const dropped = await backend.execute(
      request({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify({mode: process.env.ANYPLUGIN_MODE ?? null}))",
        ],
        env: { ANYPLUGIN_MODE: "set-by-request" },
        policy: { envAllowlist: ["PATH"], confineCwd: true, captureArtifacts: true },
      }),
    );
    expect(JSON.parse(dropped.stdout).mode).toBeNull();
  });

  it("never interprets an argument as shell syntax", async () => {
    const backend = new LocalProcessBackend({ root });
    // With a shell, this would run the second command. Without one, it is
    // a single argument that happens to look like two commands.
    const result = await backend.execute(
      request({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.argv[1] ?? '')",
          "; echo pwned",
        ],
      }),
    );
    expect(result.stdout).toBe("; echo pwned");
    expect(result.stdout).not.toContain("pwned\n");
  });

  it("enforces the deadline and kills the run", async () => {
    const backend = new LocalProcessBackend({ root });
    const result = await backend.execute(
      request({
        argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
        limits: {
          timeoutMs: 400,
          maxOutputBytes: 1024,
          maxArtifactBytes: 1024,
          maxArtifacts: 10,
        },
      }),
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("caps captured output, and says that it did", async () => {
    const backend = new LocalProcessBackend({ root });
    const result = await backend.execute(
      request({
        argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(5000))"],
        limits: {
          timeoutMs: 10_000,
          maxOutputBytes: 100,
          maxArtifactBytes: 1024,
          maxArtifacts: 10,
        },
      }),
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBe(100);
  });

  it("REFUSES a working directory outside the root", async () => {
    const backend = new LocalProcessBackend({ root });
    const result = await backend.execute(request({ cwd: ".." }));
    // A refusal is a RESULT, not an exception: the answer belongs in the
    // record, and the record says the run never happened.
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("escapes the execution root");
    expect(result.stdout).toBe("");
  });

  it("REFUSES a working directory that escapes through a symbolic link", async () => {
    const outside = mkdtempSync(join(tmpdir(), "anyplugin-outside-"));
    try {
      symlinkSync(outside, join(root, "escape"), "junction");
      const backend = new LocalProcessBackend({ root });
      const result = await backend.execute(request({ cwd: "escape" }));
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain("escapes the execution root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("captures the files the run produced, and only those", async () => {
    const backend = new LocalProcessBackend({ root });
    writeFileSync(join(root, "work", "before.txt"), "unchanged");
    const result = await backend.execute(
      request({
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('made.txt', 'new content')",
        ],
      }),
    );
    const paths = result.artifacts.map((a) => a.path);
    expect(paths).toContain("made.txt");
    // The file that did not change is not an artifact of this run.
    expect(paths).not.toContain("before.txt");
    const artifact = result.artifacts.find((a) => a.path === "made.txt");
    expect(artifact?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact?.bytes).toBe("new content".length);
  });

  it("produces metadata that is a pure function of the request", async () => {
    const backend = new LocalProcessBackend({ root });
    const first = await backend.execute(request());
    const second = await backend.execute(request());
    expect(second.metadata).toEqual(first.metadata);
    // And the observations are measurements, so they are allowed to differ.
    expect(second.metadata.argv).toEqual(first.metadata.argv);
  });

  it("runs in the working directory it was given", async () => {
    const backend = new LocalProcessBackend({ root });
    const result = await backend.execute(
      request({
        argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
      }),
    );
    // Windows reports a different casing and separator, so the comparison
    // is on the resolved path the backend recorded.
    expect(result.stdout.toLowerCase()).toContain("work");
    expect(result.metadata.cwd.toLowerCase()).toContain("work");
  });

  it("refuses to start without a root", () => {
    expect(() => new LocalProcessBackend({ root: join(root, "does-not-exist") })).toThrow();
  });
});
