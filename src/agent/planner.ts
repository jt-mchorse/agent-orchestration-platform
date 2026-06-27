import type { Plan, PlannerState, ReplanReason, Review } from "./types.js";

/**
 * Planner is the decision-maker for the agent loop.
 *
 * The interface is a single-method-Protocol-equivalent split across three
 * methods because each is invoked in a distinct phase of the run:
 *
 * - `initialPlan(input)` — called once at the start with the PR identifier.
 * - `revise(state, reason)` — called whenever the executor surfaces a
 *   `ReplanReason`. The planner returns a *new* `Plan`; the executor
 *   resumes from the first step of the new plan.
 * - `finalize(state)` — called once after the last step succeeds. Returns
 *   the structured `Review` per `docs/use-case.md` (summary +
 *   severity-tagged findings + recommendation).
 *
 * Two concrete planners ship in this repo:
 * - `ScriptedPlanner` (this file) — drives tests with a canned sequence.
 * - `AnthropicPlanner` (separate file, future) — the production planner
 *   that calls an LLM. Kept out of `#3` so the loop ships with
 *   end-to-end test coverage; it'll land alongside trace persistence
 *   (`#6`) and eval coverage (`#7`).
 */
export interface Planner {
  initialPlan(input: PlannerState["pr"]): Promise<Plan>;
  revise(state: PlannerState, reason: ReplanReason): Promise<Plan>;
  finalize(state: PlannerState): Promise<Review>;
}

/**
 * A planner with a hand-authored script.
 *
 * Used in tests (no LLM, no Anthropic SDK) and as the worked example in
 * `docs/use-case.md` for what a plan looks like. `revisions` is a list of
 * functions invoked in order — each one fires for one re-plan trigger.
 * Once exhausted, further triggers return an empty plan and the executor
 * finalizes with whatever observations it has.
 *
 * `finalReview` defaults to a generic "approve_with_comments" review so
 * test cases that don't care about the final shape can be terse. Tests
 * that *do* care pass a callback that constructs the review from the
 * observations.
 */
export class ScriptedPlanner implements Planner {
  constructor(
    private readonly initial: Plan,
    private readonly revisions: ((
      state: PlannerState,
      reason: ReplanReason,
    ) => Plan)[] = [],
    private readonly finalReview: (state: PlannerState) => Review = () => ({
      summary: "scripted review",
      findings: [],
      recommendation: "approve_with_comments",
    }),
  ) {}

  async initialPlan(): Promise<Plan> {
    return this.initial;
  }

  async revise(state: PlannerState, reason: ReplanReason): Promise<Plan> {
    // The revision index is the count of plans we've already produced —
    // one for the initial plan, plus one for each prior revise() call.
    // When no scripted revision is available, return an empty plan so the
    // executor exits cleanly rather than looping.
    const revisionIndex = state.plans.length - 1;
    const rev = this.revisions[revisionIndex];
    if (!rev) {
      return { goal: "no_more_scripted_revisions", steps: [] };
    }
    return rev(state, reason);
  }

  async finalize(state: PlannerState): Promise<Review> {
    return this.finalReview(state);
  }
}
