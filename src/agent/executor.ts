import type { ToolRegistry } from "../tools/registry.js";
import { ToolError, type ToolContext } from "../tools/types.js";
import type { Planner } from "./planner.js";
import { type SleepFn, withRetry } from "./retry.js";
import type { Trace } from "./trace.js";
import type { Observation, PlannerState, PlannedStep, ReplanReason, Review } from "./types.js";

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
  /**
   * Sleep implementation forwarded to the retry helper. Tests pass a
   * recorded-no-op so the suite stays fast; production paths get
   * `setTimeout`-based backoff by default.
   */
  sleep?: SleepFn;
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
    // Validate before any planner / tool / trace activity (#31). Sibling
    // pattern to `validatePolicy` in `retry.ts` (#29). Pre-#31 a NaN
    // maxReplans made `replans >= maxReplans` always false → the budget
    // exhaust branch was unreachable; bool / float / negative silently
    // produced misleading "max_replans_exceeded:<value>" trace events.
    validateOptions(this.opts);
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

      const observation = await this.runStepWithRetryAndFallback(step);

      state.observations.push(observation);
      this.trace.emit({ kind: "observation", observation });

      if (observation.outcome.kind === "error") {
        const error = observation.outcome.error;
        // Report the tool that actually errored (which may be the
        // fallback, not the step's primary). The trace's
        // `fallback_used` event tells the planner where the recovery
        // came from; the replan reason should name the failing tool so
        // the planner can decide whether to skip that tool entirely on
        // its next plan.
        const failingTool = error.toolName;
        const reason: ReplanReason =
          error.kind === "approval_denied"
            ? { kind: "approval_denied", toolName: failingTool, error }
            : { kind: "tool_error", toolName: failingTool, error };
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

  /**
   * Run one planned step through the recovery stack — retry on the
   * primary tool first, then one level of fallback to an alternative
   * tool if the primary tool's annotations declared one. The returned
   * `Observation` is the final outcome the planner will see; retry and
   * fallback details land in the trace as their own events so the
   * planner's view of the run stays at one observation per step.
   */
  private async runStepWithRetryAndFallback(step: PlannedStep): Promise<Observation> {
    const primaryName = step.tool;
    // 0) A plan step naming an unregistered tool is misconfiguration the planner
    //    can replan around — surface it as the step's observation, exactly like
    //    the fallback-orphan path below (`fallbackFor`) and per the documented
    //    contract in docs/architecture.md. `step.tool` is planner-supplied
    //    (LLM-generated in AnthropicPlanner), so a hallucinated/typo'd name must
    //    not crash the whole run: `registry.get` would throw a plain `Error`
    //    that the catch below re-raises as a "programmer bug", aborting before
    //    finalize() with no review or replan. The guard belongs here, not just
    //    in invokeWithRetry, because the catch would otherwise call
    //    `fallbackFor(primaryName)` whose own `registry.get(primaryName)`
    //    re-throws the same plain Error and re-crashes.
    if (!this.registry.has(primaryName)) {
      return {
        step,
        outcome: {
          kind: "error",
          error: new ToolError(primaryName, "internal", "no tool with that name is registered"),
        },
      };
    }
    // 1) Try the primary tool with its retry policy, if any.
    try {
      const value = await this.invokeWithRetry(primaryName, step.input);
      return { step, outcome: { kind: "ok", value } };
    } catch (err) {
      if (!(err instanceof ToolError)) {
        // Programmer bug — re-raise per the existing contract.
        throw err;
      }
      // Approval-class errors are human/runtime decisions, not tool failures:
      // a denied (or un-wired) destructive action must not be silently
      // "recovered" by routing to a fallback tool — that bypasses the HITL
      // checkpoint entirely (the fallback could itself be destructive). Mirror
      // the retry layer, which also never retries approval kinds, and surface
      // the denial so the planner decides via the existing replan path, where
      // `approval_denied` is already modeled as a distinct ReplanReason.
      if (err.kind === "approval_denied" || err.kind === "approval_missing") {
        return { step, outcome: { kind: "error", error: err } };
      }
      let fallbackName: string | undefined;
      try {
        fallbackName = this.fallbackFor(primaryName);
      } catch (configErr) {
        // Misconfiguration (e.g., fallbackTo points at an unregistered
        // tool). Surface it as the step's observation so the planner
        // can react via replan instead of crashing the run.
        if (configErr instanceof ToolError) {
          return { step, outcome: { kind: "error", error: configErr } };
        }
        throw configErr;
      }
      if (!fallbackName) {
        return { step, outcome: { kind: "error", error: err } };
      }
      // 2) Try the declared fallback tool. We don't follow the fallback's
      //    own fallbackTo — one hop only, so cycles are impossible by
      //    construction.
      this.trace.emit({
        kind: "fallback_used",
        from: primaryName,
        to: fallbackName,
        error: err,
      });
      try {
        const value = await this.invokeWithRetry(fallbackName, step.input);
        return { step, outcome: { kind: "ok", value } };
      } catch (fallbackErr) {
        if (!(fallbackErr instanceof ToolError)) {
          throw fallbackErr;
        }
        return { step, outcome: { kind: "error", error: fallbackErr } };
      }
    }
  }

  /**
   * Resolve a primary tool's fallback target. Returns `undefined` if no
   * fallback is configured. If a fallback is configured but the target
   * isn't registered, raises a `ToolError(kind="internal")` so the
   * caller can surface it through the existing observation path; this
   * keeps misconfiguration visible in the trace rather than crashing
   * the run.
   */
  private fallbackFor(toolName: string): string | undefined {
    const tool = this.registry.get(toolName);
    const fallback = tool.annotations?.fallbackTo;
    if (!fallback) return undefined;
    if (!this.registry.has(fallback)) {
      throw new ToolError(
        toolName,
        "internal",
        `fallbackTo=${fallback} but no tool with that name is registered`,
      );
    }
    return fallback;
  }

  /**
   * Invoke a tool with its retry policy applied. The retry policy lives
   * on the tool's annotations — see D-012 for why data-on-the-tool
   * instead of an executor-side policy map. If the tool has no retry
   * annotation, the call is a single attempt (existing behavior).
   */
  private async invokeWithRetry(toolName: string, input: unknown): Promise<unknown> {
    const tool = this.registry.get(toolName);
    const policy = tool.annotations?.retry;
    if (!policy) {
      return this.registry.invoke(toolName, input, this.ctx);
    }
    return withRetry(
      () => this.registry.invoke(toolName, input, this.ctx),
      policy,
      (attempt) => {
        this.trace.emit({
          kind: "retry_attempted",
          toolName,
          attempt: attempt.attempt,
          backoffMs: attempt.backoffMs,
          error: attempt.error,
        });
      },
      this.opts.sleep,
    );
  }
}

/**
 * Validate `ExecutorOptions` at the entry of `AgentRun.run()` (#31).
 *
 * Sibling to `validatePolicy` in `retry.ts` (#29). Each invalid numeric
 * throws `RangeError` naming the offending field and received value.
 *
 * Pre-#31 the runtime read `this.opts.maxReplans ?? DEFAULT_MAX_REPLANS`
 * and trusted it. `NaN` made `replans >= maxReplans` always false → the
 * budget exhaust branch was unreachable, re-plans looped indefinitely
 * with no terminal trace event. Bool / float / negative silently
 * produced misleading `"max_replans_exceeded:<value>"` aborts.
 *
 * Mirrors the portfolio's contract-tightening sweep — `RetryPolicy`
 * validation (#29) at the function entry, loud `RangeError` rather than
 * silent degeneracy.
 */
function validateOptions(opts: ExecutorOptions): void {
  if (opts.maxReplans !== undefined) {
    if (!Number.isInteger(opts.maxReplans) || opts.maxReplans < 1) {
      throw new RangeError(
        `ExecutorOptions.maxReplans must be an integer >= 1; got ${opts.maxReplans}`,
      );
    }
  }
}
