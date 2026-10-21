/**
 * The execution contracts (M9).
 *
 * ── Why these exist ────────────────────────────────────────────────────────
 *
 * The kernel can record, reason and verify — but it cannot yet *act*. Acting
 * means running something, and running something means three things the rest
 * of the kernel never had to worry about: a **deadline**, an **environment**,
 * and a **place on the filesystem**.
 *
 * These contracts are the shapes of those three things, plus the shape of
 * what came back. They are the *interface* the isolation milestone binds,
 * and the interface is the part that belongs to us — the infrastructure
 * behind it does not:
 *
 * > `ROADMAP.md` §6: define the `ExecutionBackend` abstraction and
 * > implement `LocalProcessBackend` **only**. The abstraction belongs to us;
 * > the infrastructure implementation does not.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * **No network policy.** A local process has whatever network access the
 * host has, and there is no portable way to take it away. A field named
 * `allowNetwork` on a policy would be a promise the implementation cannot
 * keep, and this repository does not ship promises it cannot enforce.
 *
 * **No sandbox claim.** `confinement` says the working directory is pinned
 * inside the caller's root, and the implementation enforces exactly that.
 * It does **not** say the child cannot reach the rest of the filesystem —
 * a process with filesystem permissions can. The honest statement is
 * "pinned", and the docstring says so.
 *
 * **No timing in the metadata.** The metadata is a pure function of the
 * request, so two runs of the same request produce the same metadata. The
 * duration is a *measurement*, and it lives beside the metadata rather than
 * inside it.
 *
 * ── The version ─────────────────────────────────────────────────────────────
 *
 * These shapes did not exist in `1.2.0`, so a record carrying them cannot
 * claim to be a `1.2.0` record. The contract version moves to `1.3.0` —
 * a **widening**: the existing record shapes are untouched, so a certificate
 * that binds a `1.2.0` record still verifies against it.
 */
import { z } from "zod";
import { CONTRACT_VERSION, ContentHashSchema, idSchema } from "./primitives.js";

/**
 * The bounds an execution runs inside.
 *
 * Every bound is stated in BYTES, not characters: a stream of four-byte
 * characters would use four times the intended memory if the cap were
 * counted in characters, and the accumulation guard is exactly what stops
 * an unbounded producer from exhausting the host.
 */
export const ResourceLimitsSchema = z
  .object({
    /** The hard deadline. A run that reaches it is killed, not waited on. */
    timeoutMs: z.number().int().positive().max(86_400_000),
    /** The cap on each captured stream, counted in bytes. */
    maxOutputBytes: z.number().int().positive(),
    /** The cap on one captured artifact, counted in bytes. */
    maxArtifactBytes: z.number().int().positive(),
    /** How many artifacts one execution may produce. */
    maxArtifacts: z.number().int().positive(),
  })
  .strict();
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

/**
 * The policy an execution runs under.
 *
 * Every field here is ENFORCED by the backend that honours it. A policy
 * field with no enforcement is a setting, not a policy.
 */
export const ExecutionPolicySchema = z
  .object({
    /**
     * The environment variables the child may see.
     *
     * An allowlist, not a denylist: the child's environment is built from
     * this list and from the request's explicit variables, and everything
     * else is **absent**. A denylist would leak whatever the host happened
     * to be carrying — a token, a proxy setting, a credential in a
     * variable nobody remembered.
     */
    envAllowlist: z.array(z.string().min(1)).min(1),
    /**
     * Whether the working directory is confined to the request's root.
     *
     * When true, a root that resolves outside the caller's root is
     * REFUSED, and the refusal is recorded as a failure rather than an
     * exception. This is working-directory confinement, not filesystem
     * confinement — see the module docstring.
     */
    confineCwd: z.boolean(),
    /** Whether files the child writes under the root are captured as artifacts. */
    captureArtifacts: z.boolean(),
  })
  .strict();
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

/**
 * A request to run something.
 *
 * The command is an **argv array**, never a string. A string would be
 * interpreted by a shell, and a shell turns an argument into syntax — which
 * is how an argument becomes an injection.
 */
export const ExecutionRequestSchema = z
  .object({
    id: idSchema("execution"),
    contractVersion: z.literal(CONTRACT_VERSION),
    /** The command and its arguments. The first element is the executable. */
    argv: z.array(z.string().min(1)).min(1),
    /** The working directory, relative to the caller's root. */
    cwd: z.string().min(1),
    /** Environment variables to set, on top of the allowlist. */
    env: z.record(z.string(), z.string()),
    limits: ResourceLimitsSchema,
    policy: ExecutionPolicySchema,
  })
  .strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

/**
 * One file the execution produced.
 *
 * The path is RELATIVE to the execution's root, so the record is portable
 * and a capture cannot be mistaken for a claim about the host's filesystem.
 */
export const ArtifactCaptureSchema = z
  .object({
    /** The path, relative to the execution's root. */
    path: z.string().min(1),
    /** The hash of the captured bytes, so tampering is detectable. */
    contentHash: ContentHashSchema,
    /** How many bytes were captured. */
    bytes: z.number().int().nonnegative(),
    /** Whether the capture was cut at the artifact limit. */
    truncated: z.boolean(),
  })
  .strict();
export type ArtifactCapture = z.infer<typeof ArtifactCaptureSchema>;

/**
 * The deterministic facts about an execution.
 *
 * A pure function of the request: the same request produces the same
 * metadata. Nothing here is measured, and nothing here is a clock.
 */
export const ExecutionMetadataSchema = z
  .object({
    /** The argv the child was given. */
    argv: z.array(z.string()),
    /** The working directory the child was given, resolved. */
    cwd: z.string(),
    /** The names of the environment variables the child could see. */
    envKeys: z.array(z.string()),
    /** The limits in force. */
    limits: ResourceLimitsSchema,
    /** The policy in force. */
    policy: ExecutionPolicySchema,
  })
  .strict();
export type ExecutionMetadata = z.infer<typeof ExecutionMetadataSchema>;

/**
 * What came back.
 *
 * The observations are measurements and are NOT deterministic — the same
 * request produces different results. The metadata beside them is.
 */
export const ExecutionResultSchema = z
  .object({
    id: idSchema("execution"),
    contractVersion: z.literal(CONTRACT_VERSION),
    /** The exit status, or null when the process was killed by a signal. */
    exitCode: z.number().int().nullable(),
    /** The signal that ended the process, or null. */
    signal: z.string().nullable(),
    /** Whether the deadline was reached and the process killed. */
    timedOut: z.boolean(),
    /** The captured standard output, capped. */
    stdout: z.string(),
    /** Whether standard output was cut at the limit. */
    stdoutTruncated: z.boolean(),
    /** The captured standard error, capped. */
    stderr: z.string(),
    /** Whether standard error was cut at the limit. */
    stderrTruncated: z.boolean(),
    /** The files the execution produced under its root. */
    artifacts: z.array(ArtifactCaptureSchema),
    /** The deterministic facts about the execution. */
    metadata: ExecutionMetadataSchema,
  })
  .strict();
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
