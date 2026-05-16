import type { Observation, Plan, PlannedStep, PlannerState, ReplanReason, Review } from "./types.js";

/**
 * One thing that happened during a run.
 *
 * The trace shape mirrors the lifecycle the executor walks: a `run_started`
 * at the top, a `plan_emitted` for the initial plan and each revision, a
 * `step_started` + `observation` pair per executed step, a
 * `re_plan_triggered` between a failing observation and the next plan, and
 * a `finalized` at the end (or `aborted` if the re-plan budget is busted).
 *
 * `#6` will persist this to Postgres; this in-memory shape is the schema
 * Postgres will mirror, so the migration is a serialization step rather
 * than a rewrite.
 */
export type TraceEvent =
  | { ts: number; kind: "run_started"; pr: PlannerState["pr"] }
  | { ts: number; kind: "plan_emitted"; plan: Plan; version: number }
  | { ts: number; kind: "step_started"; step: PlannedStep; index: number }
  | { ts: number; kind: "observation"; observation: Observation }
  | { ts: number; kind: "re_plan_triggered"; reason: ReplanReason }
  | { ts: number; kind: "finalized"; review: Review }
  | { ts: number; kind: "aborted"; reason: string };

/** Pluggable clock so tests get deterministic timestamps. */
export type Clock = () => number;

/**
 * Distributes `Omit<_, K>` across each variant of a discriminated union.
 * `Omit<TraceEvent, "ts">` would collapse the union into an intersection of
 * all variants; this preserves per-variant shapes so `emit({ kind, ... })`
 * type-checks against exactly one variant at a time.
 */
type DistributeOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * In-memory append-only event log for one agent run.
 *
 * `emit()` stamps the event with the configured clock and pushes it onto
 * the log. `events()` returns a defensive shallow copy so callers can't
 * mutate the log out from under the executor. The class is deliberately
 * small — `#6` will swap the in-memory store for a Postgres writer
 * implementing the same `emit()` contract.
 */
export class Trace {
  private readonly log: TraceEvent[] = [];
  private readonly clock: Clock;

  constructor(opts: { clock?: Clock } = {}) {
    // Default: monotonic ms-since-epoch. Tests pass a deterministic clock.
    this.clock = opts.clock ?? (() => Date.now());
  }

  emit(event: DistributeOmit<TraceEvent, "ts">): void {
    // The distributed-Omit type preserves each variant's discriminant, so
    // the spread below is a sound narrowing — `kind` plus the variant's
    // own keys, with `ts` supplied here.
    this.log.push({ ts: this.clock(), ...event } as TraceEvent);
  }

  events(): TraceEvent[] {
    return [...this.log];
  }

  /** Convenience: filter the log to one kind, preserving ordering. */
  ofKind<K extends TraceEvent["kind"]>(
    kind: K,
  ): Extract<TraceEvent, { kind: K }>[] {
    return this.log.filter(
      (e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind,
    );
  }
}
