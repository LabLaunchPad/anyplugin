/**
 * The Experience Ledger (M4).
 *
 * ── The constraint this ledger exists to enforce ───────────────────────────
 *
 * > A lesson must never auto-promote to authoritative evidence.
 *
 * Most memory systems silently blur *what happened* with *what we learned*
 * with *what is true*. This ledger keeps the three apart, and it does that
 * by making the ladder **append-only**: an experience's rung changes only
 * when an `EXPERIENCE_PROMOTED` event says so, and never by anything the
 * fold does.
 *
 * That is the whole acceptance criterion (M4): *a test proves a `LESSON`
 * cannot become authoritative evidence without an explicit, evidenced
 * promotion*. So the tests here are:
 *
 * 1. the fold never advances a rung — not on its own, not for a record that
 *    arrives already at a higher rung than the ledger's history implies;
 * 2. a promotion advances by **exactly one** rung — no skipping, no
 *    demotion, no lateral move;
 * 3. a promotion to `VERIFIED_KNOWLEDGE` needs **evidence** and a
 *    **justification**, and is refused without them; and
 * 4. the promotion is an **event**, so it is replayable and auditable.
 *
 * ── Why one rung at a time ─────────────────────────────────────────────────
 *
 * The ladder is `OBSERVATION → LESSON → HYPOTHESIS → VERIFIED_KNOWLEDGE`.
 * `rungIndex()` exists in the contracts for exactly this assertion: *"for
 * asserting that promotion never skips or auto-advances"*. A promotion from
 * `OBSERVATION` straight to `VERIFIED_KNOWLEDGE` skips the two rungs in
 * between, and each of them is a distinct epistemic claim — *this is what
 * happened*, *this is what I learned*, *this is what I now believe*. Jumping
 * from the first to the last asserts the third on the strength of the first.
 */
import {
  CONTRACT_VERSION,
  ExperienceSchema,
  rungIndex,
  type EpistemicRung,
  type Experience,
  type WorkerEvent,
} from "../contracts/index.js";
import { eventIdOf, type WorkerEventDraft } from "./event-id.js";

/** The experience, as the log projects it. */
export interface ExperienceProjection {
  readonly id: string;
  readonly contractId: string;
  readonly action: string;
  readonly outcome: Experience["outcome"];
  readonly failureClass?: Experience["failureClass"];
  readonly lesson: string;
  /** Where on the epistemic ladder this sits. Changed only by an event. */
  readonly rung: EpistemicRung;
  readonly evidence: readonly string[];
  readonly confidence: number;
  readonly validWhen: Readonly<Record<string, string>>;
  readonly invalidatedBy: readonly string[];
}

export interface ExperienceFoldResult {
  readonly experiences: Map<string, ExperienceProjection>;
  readonly ignored: number;
  /** The records whose payload could not be read. Recorded, never coerced. */
  readonly rejected: readonly string[];
}

/** Fold the experience events into experience projections. */
export function foldExperience(events: readonly WorkerEvent[]): ExperienceFoldResult {
  const experiences = new Map<string, ExperienceProjection>();
  const rejected: string[] = [];
  let ignored = 0;

  for (const event of events) {
    if (event.kind === "EXPERIENCE_RECORDED") {
      const parsed = ExperienceSchema.safeParse(event.payload["experience"]);
      if (!parsed.success) {
        rejected.push(event.subject);
        continue;
      }
      const record: Experience = parsed.data;
      experiences.set(record.id, {
        id: record.id,
        contractId: record.contractId,
        action: record.action,
        outcome: record.outcome,
        ...(record.failureClass ? { failureClass: record.failureClass } : {}),
        lesson: record.lesson,
        rung: record.rung,
        evidence: [...record.evidence],
        confidence: record.confidence,
        validWhen: { ...record.validWhen },
        invalidatedBy: [...record.invalidatedBy],
      });
      continue;
    }

    if (event.kind === "EXPERIENCE_PROMOTED") {
      const current = experiences.get(event.subject);
      if (!current) {
        rejected.push(event.subject);
        continue;
      }
      const to = event.payload["to"];
      if (typeof to !== "string" || !isRung(to)) {
        rejected.push(event.subject);
        continue;
      }
      const evidence = event.payload["evidence"];
      experiences.set(event.subject, {
        ...current,
        rung: to,
        evidence: Array.isArray(evidence) ? evidence.filter((e): e is string => typeof e === "string") : current.evidence,
      });
      continue;
    }

    ignored += 1;
  }

  return { experiences, ignored, rejected };
}

const RUNGS: ReadonlySet<string> = new Set(["OBSERVATION", "LESSON", "HYPOTHESIS", "VERIFIED_KNOWLEDGE"]);

function isRung(value: string): value is EpistemicRung {
  return RUNGS.has(value);
}

// ── The promotion ─────────────────────────────────────────────────────────

export interface PromotionInput {
  /** The experience being promoted. */
  readonly experience: ExperienceProjection;
  /** The rung it is promoted TO. */
  readonly to: EpistemicRung;
  /**
   * The evidence backing the promotion.
   *
   * **Required for `VERIFIED_KNOWLEDGE`** — that is the contract's own
   * refinement, and it is the whole point of the rung: authoritative
   * knowledge is knowledge that cites its evidence.
   */
  readonly evidence?: readonly string[];
  /** Why the promotion is warranted. Required — a promotion without a reason is a claim without a justification. */
  readonly justification: string;
  readonly at: string;
  readonly actor: string;
}

export interface PromotionPlan {
  /** The event to append, when the promotion is legal. */
  readonly event?: WorkerEventDraft;
  /** Why the promotion was refused, when it was. */
  readonly refused?: string;
}

/**
 * Propose a promotion up the epistemic ladder.
 *
 * The rules, in the order they are checked:
 *
 * 1. **No demotion and no lateral move.** The ladder only goes up.
 * 2. **No skipping.** Exactly one rung per promotion.
 * 3. **`VERIFIED_KNOWLEDGE` needs evidence.** No evidence, no promotion.
 * 4. **Every promotion needs a justification.** A promotion without one is a
 *    claim without a reason, and the ledger exists to keep the two apart.
 *
 * And the rule that is not in this function at all: **nothing promotes
 * automatically.** There is no path from an `EXPERIENCE_RECORDED` event to a
 * higher rung. The fold does not do it, the verifier does not do it, and
 * only this function — which requires an actor and a justification — can.
 */
export function planPromotion(input: PromotionInput): PromotionPlan {
  const from = input.experience.rung;
  const to = input.to;

  if (rungIndex(to) <= rungIndex(from)) {
    return {
      refused: `a promotion must go UP the ladder: ${from} -> ${to} is not an advance`,
    };
  }
  if (rungIndex(to) - rungIndex(from) !== 1) {
    return {
      refused: `a promotion must advance by exactly one rung: ${from} -> ${to} skips ${rungIndex(to) - rungIndex(from) - 1}`,
    };
  }
  const evidence = input.evidence ?? [];
  if (to === "VERIFIED_KNOWLEDGE" && evidence.length === 0) {
    return {
      refused: "VERIFIED_KNOWLEDGE requires supporting evidence; a lesson never auto-promotes to authoritative knowledge",
    };
  }
  if (input.justification.trim() === "") {
    return { refused: "a promotion must state a justification" };
  }

  const draft: Omit<WorkerEvent, "id" | "sequence"> = {
    contractVersion: CONTRACT_VERSION,
    at: input.at,
    actor: input.actor,
    kind: "EXPERIENCE_PROMOTED",
    subject: input.experience.id,
    payload: { to, evidence: [...evidence], justification: input.justification },
  };
  return { event: { ...draft, id: eventIdOf(draft) } };
}
