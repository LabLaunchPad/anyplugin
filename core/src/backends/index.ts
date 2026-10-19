/**
 * The backend registry — a declarative description of the runtimes a wrapper
 * may delegate to.
 *
 * ── Why a registry, and why it is DATA ─────────────────────────────────────
 *
 * A wrapper that drives other runtimes needs three things kept apart:
 *
 *   1. IDENTITY     — what a backend IS: how to start it, what it can do.
 *   2. CAPABILITY   — what it is allowed to do, and how confident we are.
 *   3. POLICY       — what to DO with it: order, budgets, failure handling.
 *
 * Conflating them is the most common design mistake in routing systems, and
 * it is why they are separate files: identity and capability change when the
 * upstream tool changes; policy changes when the operator changes their mind.
 * A registry that mixes them cannot be updated independently, and a policy
 * that lives in code cannot be reviewed.
 *
 * So this module owns (1) and (2) only. The policy lives in the wrapper.
 *
 * ── The rules this registry enforces ───────────────────────────────────────
 *
 *   - Unknown fields are REJECTED. A typo like `capabilites` must fail
 *     validation, not be silently ignored — a silently ignored capability is
 *     a capability the wrapper believes it does not have, which is the safe
 *     direction, but a silently ignored `timeoutMs` is a hang.
 *   - An unknown registry `apiVersion` FAILS CLOSED. The registry is refused
 *     whole; it is never half-read.
 *   - A capability the backend does not declare is UNKNOWN, and UNKNOWN forces
 *     the caller to fail closed. This mirrors `core/src/capabilities/matrix.ts`.
 *   - The registry distinguishes "empty" from "unreachable": an empty registry
 *     is a valid, if useless, state; an unreadable one is an error.
 */
import { z } from "zod";

/** The registry format version this build understands. */
export const BACKEND_REGISTRY_VERSION = 1;

/** How a backend is invoked. */
export const BACKEND_KINDS = ["cli", "acp", "http"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

/**
 * How well a backend is known to support a capability.
 *
 * Deliberately the same four verdicts as `core/src/capabilities/matrix.ts`,
 * so one rule governs the whole system: UNKNOWN fails closed.
 */
export const BACKEND_SUPPORT = ["NATIVE", "DEGRADED", "UNSUPPORTED", "UNKNOWN"] as const;
export type BackendSupport = (typeof BACKEND_SUPPORT)[number];

/** Circuit-breaker policy for one backend. */
export const BackendCircuitPolicySchema = z
  .object({
    /** Consecutive failures needed to open the circuit. */
    failureThreshold: z.number().int().positive().max(100).default(3),
    /** How long the circuit stays open before a trial attempt is allowed. */
    cooldownMs: z.number().int().nonnegative().max(3_600_000).default(30_000),
    /** Consecutive half-open successes needed to close the circuit. */
    successThreshold: z.number().int().positive().max(100).default(1),
  })
  .strict();
export type BackendCircuitPolicy = z.infer<typeof BackendCircuitPolicySchema>;

/**
 * How to start and identify a CLI backend.
 *
 * `probe` is how the wrapper asks "are you there?" without running the real
 * work — almost always a `--version` invocation with a short timeout.
 */
export const BackendProbeSchema = z
  .object({
    /**
     * The command to run for the probe. Defaults to the backend's own command.
     *
     * A probe usually needs a DIFFERENT command line from the real work: a
     * backend whose real invocation is `claude --print` must be probed with
     * `claude --version`, not `claude --print --version`. Overriding the
     * command explicitly is what makes that expressible.
     */
    command: z.string().min(1).optional(),
    /** The argv (without the command) used to probe. Replaces the backend's own args. */
    argv: z.array(z.string()).default(["--version"]),
    /** How long the probe may take. */
    timeoutMs: z.number().int().positive().max(60_000).default(5_000),
    /** A pattern that extracts the version from the probe's output. */
    versionPattern: z.string().optional(),
  })
  .strict();
export type BackendProbe = z.infer<typeof BackendProbeSchema>;

/** One backend. */
export const BackendSpecSchema = z
  .object({
    /** Stable slug. Kebab-case; it appears in telemetry and in the log. */
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "backend id must be kebab-case"),
    /** Human-readable name, for display only. */
    label: z.string().min(1).default(""),
    /** How this backend is invoked. */
    kind: z.enum(BACKEND_KINDS).default("cli"),
    /** The command to run (CLI backends). */
    command: z.string().min(1).optional(),
    /** Arguments always passed to the command. */
    args: z.array(z.string()).default([]),
    /**
     * Capabilities this backend declares, with the support verdict for each.
     * A capability that is NOT listed is UNKNOWN, not UNSUPPORTED — the
     * distinction matters, and it is the reason this is a map.
     */
    capabilities: z.record(z.string(), z.enum(BACKEND_SUPPORT)).default({}),
    /** Free-form domains this backend serves ("code", "docs", "ops"). */
    domains: z.array(z.string()).default([]),
    /** How long one delegated attempt may take. */
    timeoutMs: z.number().int().positive().max(600_000).default(60_000),
    /** Whether this backend may be selected at all. */
    enabled: z.boolean().default(true),
    /** Circuit policy for this backend. */
    circuit: BackendCircuitPolicySchema.default({
      failureThreshold: 3,
      cooldownMs: 30_000,
      successThreshold: 1,
    }),
    /** How to probe for availability. */
    probe: BackendProbeSchema.optional(),
    /**
     * Environment variables to pass through to the backend.
     *
     * This is an ALLOWLIST, not a blocklist. A blocklist has to anticipate
     * every secret; an allowlist only has to name the ones that are meant.
     */
    env: z.record(z.string(), z.string()).default({}),
    /**
     * Audited provenance. A backend's facts are only as good as the evidence
     * behind them, so the source and the date it was verified are recorded.
     */
    verified: z
      .object({
        at: z.string().min(1),
        source: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BackendSpec = z.infer<typeof BackendSpecSchema>;

/** A whole registry. */
export const BackendRegistrySchema = z
  .object({
    /** Registry format version. An unknown version is refused whole. */
    apiVersion: z.literal(BACKEND_REGISTRY_VERSION),
    /** The backends. May be empty — an empty registry is valid. */
    backends: z.array(BackendSpecSchema).default([]),
  })
  .strict();
export type BackendRegistry = z.infer<typeof BackendRegistrySchema>;

/**
 * Parse a registry, refusing anything this build does not understand.
 *
 * The refusal is deliberate and total: a registry that declares a future
 * format may use fields this build would ignore, and ignoring them is how a
 * wrapper ends up running a backend without the policy it was configured with.
 */
export function parseBackendRegistry(raw: unknown): BackendRegistry {
  const candidate = raw as { apiVersion?: unknown };
  if (candidate && typeof candidate === "object" && candidate.apiVersion !== undefined) {
    if (candidate.apiVersion !== BACKEND_REGISTRY_VERSION) {
      throw new Error(
        `unsupported backend registry apiVersion: ${String(candidate.apiVersion)} (this build understands ${BACKEND_REGISTRY_VERSION})`,
      );
    }
  }
  const parsed = BackendRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid backend registry: ${issues}`);
  }
  // Two backends with the same id would make selection ambiguous.
  const seen = new Set<string>();
  for (const backend of parsed.data.backends) {
    if (seen.has(backend.id)) throw new Error(`invalid backend registry: duplicate backend id "${backend.id}"`);
    seen.add(backend.id);
  }
  return parsed.data;
}

/**
 * The support verdict for a capability of a backend.
 *
 * A capability the backend does not mention is UNKNOWN — and UNKNOWN forces
 * the caller to fail closed. Treating "not mentioned" as UNSUPPORTED would be
 * a different failure (it would silently exclude a capable backend); treating
 * it as NATIVE would be worse (it would run something that cannot do the job).
 */
export function backendSupport(spec: BackendSpec, capability: string): BackendSupport {
  return spec.capabilities[capability] ?? "UNKNOWN";
}

/** Every backend that declares a capability, in registry order. */
export function backendsWithCapability(registry: BackendRegistry, capability: string): BackendSpec[] {
  return registry.backends.filter((b) => backendSupport(b, capability) !== "UNSUPPORTED" && backendSupport(b, capability) !== "UNKNOWN");
}

/** Every backend that serves a domain, in registry order. */
export function backendsWithDomain(registry: BackendRegistry, domain: string): BackendSpec[] {
  return registry.backends.filter((b) => b.domains.includes(domain));
}

/** A registry lookup. */
export class BackendCatalog {
  readonly #registry: BackendRegistry;
  readonly #byId: Map<string, BackendSpec>;

  constructor(registry: BackendRegistry) {
    this.#registry = registry;
    this.#byId = new Map(registry.backends.map((b) => [b.id, b]));
  }

  /** Parse and index a registry. Throws on an invalid or future-version registry. */
  static parse(raw: unknown): BackendCatalog {
    return new BackendCatalog(parseBackendRegistry(raw));
  }

  get registry(): BackendRegistry {
    return this.#registry;
  }

  /** Every backend, enabled or not. */
  all(): BackendSpec[] {
    return [...this.#registry.backends];
  }

  /** Every ENABLED backend. */
  enabled(): BackendSpec[] {
    return this.#registry.backends.filter((b) => b.enabled);
  }

  /** Look up one backend by id, or null. */
  get(id: string): BackendSpec | null {
    return this.#byId.get(id) ?? null;
  }

  /** Candidates for a request, in registry order. */
  candidates(capability?: string, domain?: string): BackendSpec[] {
    let list = this.enabled();
    if (capability) list = list.filter((b) => backendSupport(b, capability) === "NATIVE" || backendSupport(b, capability) === "DEGRADED");
    if (domain) list = list.filter((b) => b.domains.includes(domain));
    return list;
  }
}
