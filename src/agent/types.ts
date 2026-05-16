import type { ToolError } from "../tools/types.js";

/**
 * One step in a Plan: a single tool invocation the executor will run.
 *
 * `rationale` is the *decision* — the planner's reason for choosing this
 * step. It's logged into the trace so a human (and #6's UI) can see why
 * the agent went down a particular path.
 *
 * `expected` is optional and used only by re-plan heuristics that need to
 * detect "the observation didn't look like what we asked for" without a
 * thrown error (e.g., `fetch_pr` returned 0 changed files). The default
 * executor only triggers re-plan on thrown `ToolError`s; callers that
 * need shape-based re-plan can add a check in their planner's logic.
 */
export interface PlannedStep {
  rationale: string;
  tool: string;
  input: unknown;
}

/**
 * A plan is a goal plus the steps the planner intends to take to satisfy it.
 *
 * Plans are *append-only* in the executor's state: when the planner
 * revises, the new plan is added to `PlannerState.plans`; the old plan
 * isn't mutated. This makes the trace immutable and replayable.
 */
export interface Plan {
  goal: string;
  steps: PlannedStep[];
}

/**
 * What the executor observed when it ran a step.
 *
 * `kind: "ok"` carries the tool's parsed output (the registry already ran
 * the tool's `outputSchema` against it before returning). `kind: "error"`
 * carries the `ToolError` — this is what the planner gets to react to.
 */
export type Observation =
  | { step: PlannedStep; outcome: { kind: "ok"; value: unknown } }
  | { step: PlannedStep; outcome: { kind: "error"; error: ToolError } };

/**
 * Why the executor asked the planner to revise.
 *
 * The two concrete reasons today are:
 * - `tool_error` — the registry surfaced a `ToolError` (input/output
 *   validation, not_found, unsupported_in_replay, internal).
 * - `approval_denied` — a destructive tool's approval provider returned
 *   `approved: false`. Modeled separately from `tool_error` so the
 *   planner can choose a totally different strategy (e.g., skip posting
 *   the comment and just print the review locally).
 */
export type ReplanReason =
  | { kind: "tool_error"; toolName: string; error: ToolError }
  | { kind: "approval_denied"; toolName: string; error: ToolError };

/**
 * State the executor maintains across the run.
 *
 * `plans[0]` is always the planner's initial plan; subsequent entries are
 * revisions in order. `observations` is chronological and covers all plans
 * — that's by design, since a revision is a continuation, not a fresh run.
 */
export interface PlannerState {
  pr: { owner: string; repo: string; number: number };
  plans: Plan[];
  observations: Observation[];
}

/** Severity tags from `docs/use-case.md`. */
export type FindingSeverity = "blocker" | "concern" | "nit" | "praise";

export interface Finding {
  severity: FindingSeverity;
  message: string;
  file?: string;
  lineRange?: [number, number];
}

export interface Review {
  summary: string;
  findings: Finding[];
  recommendation: "request_changes" | "approve_with_comments" | "approve";
}
