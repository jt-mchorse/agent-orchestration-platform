import type { ToolRegistry } from "../tools/registry.js";
import { ToolError, type ToolContext } from "../tools/types.js";
import type { Planner } from "./planner.js";
import type { Trace } from "./trace.js";
import type { Observation, PlannerState, ReplanReason, Review } from "./types.js";

/**
 * Hard upper bound on how many times the planner can re-plan in one run.
 *
 * Bounded retries prevent a misbehaving planner (or a deterministic
 * tool-error → revise-to-same-plan loop) from running forever and burning
 * dollars. 5 is loose enough for normal paths (fetch fails → planner tries
 * a different repo handle → succeeds) and tight enough that infinite
 * loops surface as test failures within seconds.
 */
export const DEFAULT_MAX_REPLANS = 5;

export interface ExecutorOptions {
  /** Override the default replan budget for one run. */
  maxReplans?: number;
}

export class AgentRun {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly planner: Planner,
    private readonly trace: Trace,
    private readonly ctx: ToolContext,
    private readonly opts: ExecutorOptions = {},
  ) {}

  async run(pr: PlannerState["pr"]): Promise<Review> {
    const maxReplans = this.opts.maxReplans ?? DEFAULT_MAX_REPLANS;

    this.trace.emit({ kind: "run_started", pr });

    const state: PlannerState = { pr, plans: [], observations: [] };

    // Initial plan.
    let plan = await this.planner.initialPlan(pr);
    state.plans.push(plan);
    this.trace.emit({ kind: "plan_emitted", plan, version: 0 });

    let replans = 0;
    let stepIndex = 0;

    // The loop walks the current plan's steps in order. On a tool error or
    // approval denial, we ask the planner to revise, push the new plan,
    // and resume from its first step. On budget exhaustion, we abort
    // cleanly: the finalize() call still runs so the operator gets the
    // partial review with whatever findings the planner can derive.
    while (stepIndex < plan.steps.length) {
      const step = plan.steps[stepIndex];
      if (!step) break; // unreachable under the loop guard; satisfies noUncheckedIndexedAccess
      this.trace.emit({ kind: "step_started", step, index: stepIndex });

      let observation: Observation;
      try {
        const value = await this.registry.invoke(step.tool, step.input, this.ctx);
        observation = { step, outcome: { kind: "ok", value } };
      } catch (err) {
        if (err instanceof ToolError) {
          observation = { step, outcome: { kind: "error", error: err } };
        } else {
          // A non-ToolError leak from the registry is a programmer error,
          // not a re-plannable agent decision — surface it instead of
          // converting to a re-plan trigger.
          throw err;
        }
      }

      state.observations.push(observation);
      this.trace.emit({ kind: "observation", observation });

      if (observation.outcome.kind === "error") {
        const error = observation.outcome.error;
        const reason: ReplanReason =
          error.kind === "approval_denied"
            ? { kind: "approval_denied", toolName: step.tool, error }
            : { kind: "tool_error", toolName: step.tool, error };
        this.trace.emit({ kind: "re_plan_triggered", reason });

        if (replans >= maxReplans) {
          this.trace.emit({
            kind: "aborted",
            reason: `max_replans_exceeded:${maxReplans}`,
          });
          // Fall through to finalize() — the planner still gets a chance
          // to assemble a partial review from the observations it has.
          break;
        }

        plan = await this.planner.revise(state, reason);
        state.plans.push(plan);
        replans += 1;
        this.trace.emit({
          kind: "plan_emitted",
          plan,
          version: state.plans.length - 1,
        });
        stepIndex = 0;
        continue;
      }

      stepIndex += 1;
    }

    const review = await this.planner.finalize(state);
    this.trace.emit({ kind: "finalized", review });
    return review;
  }
}
