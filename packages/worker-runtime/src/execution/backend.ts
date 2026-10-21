/**
 * The execution backend abstraction (M9).
 *
 * ── The rule this file exists to enforce ───────────────────────────────────
 *
 * > `ROADMAP.md` §6: define the `ExecutionBackend` abstraction and
 * > implement `LocalProcessBackend` **only**. The abstraction belongs to us;
 * > the infrastructure implementation does not. Docker → Apple Virtualization
 * > → Firecracker → remote workers get added later, behind the same
 * > interface, without touching the primitives.
 *
 * So this file is the part we keep, and `local-process.ts` is the one
 * implementation. A virtual-machine backend added later implements THIS and
 * touches nothing in State, Evidence, Decision or Verification — which is
 * the milestone's acceptance criterion, and it is checkable: the kernel's
 * other primitives must not import the backend.
 *
 * ── What this interface is, today ──────────────────────────────────────────
 *
 * It is the **execution** half: run something, under bounds, and report
 * what came back and what it produced.
 *
 * It is NOT yet the full workspace contract the kernel document sketches —
 * `create` · `snapshot` · `read` · `write` · `diff` · `rollback` ·
 * `destroy`. Those are the *sandbox* half: a workspace whose changes can be
 * inspected and undone. They are not built, and declaring them here would be
 * declaring a method with no implementation — the failure mode this
 * repository has already written a post-mortem about.
 *
 * The shape is therefore small on purpose: an interface with one method is
 * an interface a second implementation can satisfy.
 */
import type { ExecutionRequest, ExecutionResult } from "../contracts/index.js";

/**
 * Something that can run a request and report what happened.
 *
 * Implementations MUST:
 *
 * - never use a shell (the argv array goes to the OS unchanged);
 * - honour the request's deadline, and kill the process when it is reached;
 * - build the child's environment from the allowlist, and give it nothing
 *   else;
 * - cap captured output, in bytes; and
 * - report a failure as a **result**, not as an exception — a backend that
 *   throws cannot say what the run did, and "what did the run do" is the
 *   only thing the caller is asking.
 */
export interface ExecutionBackend {
  /** The backend's name, for the record. */
  readonly kind: string;

  /**
   * Run a request.
   *
   * Resolves with the result. It does not reject for a failed run: a
   * non-zero exit, a timeout and a refused working directory are all
   * *results*. It rejects only when the backend itself could not attempt
   * the run at all.
   */
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
