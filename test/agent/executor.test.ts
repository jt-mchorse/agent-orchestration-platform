import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentRun } from "../../src/agent/executor.js";
import { ScriptedPlanner } from "../../src/agent/planner.js";
import { Trace } from "../../src/agent/trace.js";
import type { Plan, Review } from "../../src/agent/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ToolError, type Tool, type ToolContext } from "../../src/tools/types.js";

// ---------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------

const pingIn = z.object({ msg: z.string().min(1) });
const pingOut = z.object({ pong: z.string() });

const pingTool: Tool<typeof pingIn, typeof pingOut> = {
  name: "ping",
  description: "echoes input.msg back as pong",
  inputSchema: pingIn,
  outputSchema: pingOut,
  async run(input) {
    return { pong: input.msg };
  },
};

// Tool that always fails — drives the re-plan path.
const explodeIn = z.object({});
const explodeOut = z.object({ ok: z.boolean() });
const explodeTool: Tool<typeof explodeIn, typeof explodeOut> = {
  name: "explode",
  description: "always throws an internal ToolError",
  inputSchema: explodeIn,
  outputSchema: explodeOut,
  async run() {
    throw new ToolError("explode", "internal", "intentional failure for tests");
  },
};

// Destructive tool — its registry invocation requires an approval provider.
const postIn = z.object({ body: z.string().min(1) });
const postOut = z.object({ posted: z.boolean() });
const postTool: Tool<typeof postIn, typeof postOut> = {
  name: "post",
  description: "pretend to post something",
  inputSchema: postIn,
  outputSchema: postOut,
  annotations: { destructive: true, destructiveReason: "post on a real PR" },
  async run() {
    return { posted: true };
  },
};

function deterministicClock(): { tick: () => number } {
  let n = 0;
  return { tick: () => ++n };
}

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(pingTool);
  r.register(explodeTool);
  r.register(postTool);
  return r;
}

const PR = { owner: "jt-mchorse", repo: "test", number: 1 };

// ---------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------

describe("AgentRun — happy path", () => {
  it("runs every step in order and finalizes with the planner's review", async () => {
    const plan: Plan = {
      goal: "ping twice and finalize",
      steps: [
        { rationale: "warm up", tool: "ping", input: { msg: "one" } },
        { rationale: "confirm", tool: "ping", input: { msg: "two" } },
      ],
    };
    const expectedReview: Review = {
      summary: "fine",
      findings: [],
      recommendation: "approve",
    };
    const planner = new ScriptedPlanner(plan, [], () => expectedReview);
    const trace = new Trace({ clock: deterministicClock().tick });
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    const run = new AgentRun(buildRegistry(), planner, trace, ctx);
    const review = await run.run(PR);

    expect(review).toEqual(expectedReview);

    const kinds = trace.events().map((e) => e.kind);
    expect(kinds).toEqual([
      "run_started",
      "plan_emitted",
      "step_started",
      "observation",
      "step_started",
      "observation",
      "finalized",
    ]);
  });

  it("makes the planner's rationale visible in the trace", async () => {
    const plan: Plan = {
      goal: "single step",
      steps: [
        {
          rationale: "we need the PR metadata before doing anything else",
          tool: "ping",
          input: { msg: "hello" },
        },
      ],
    };
    const planner = new ScriptedPlanner(plan);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await new AgentRun(buildRegistry(), planner, trace, ctx).run(PR);

    const stepStarts = trace.ofKind("step_started");
    expect(stepStarts).toHaveLength(1);
    expect(stepStarts[0]?.step.rationale).toContain("PR metadata");
  });

  it("handles an empty plan by going straight to finalize", async () => {
    const planner = new ScriptedPlanner({ goal: "noop", steps: [] });
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    const review = await new AgentRun(buildRegistry(), planner, trace, ctx).run(PR);

    expect(review.summary).toBe("scripted review");
    expect(trace.ofKind("step_started")).toHaveLength(0);
    expect(trace.ofKind("finalized")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// Re-plan paths
// ---------------------------------------------------------------------

describe("AgentRun — re-plan", () => {
  it("revises on tool_error and resumes with the new plan", async () => {
    // First plan: ping then explode. Revised plan: just ping again.
    const initial: Plan = {
      goal: "try the risky thing first",
      steps: [
        { rationale: "warm up", tool: "ping", input: { msg: "warm" } },
        { rationale: "this will fail", tool: "explode", input: {} },
      ],
    };
    const revised: Plan = {
      goal: "back off to a safe call",
      steps: [{ rationale: "safe fallback", tool: "ping", input: { msg: "fallback" } }],
    };
    const planner = new ScriptedPlanner(initial, [() => revised]);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await new AgentRun(buildRegistry(), planner, trace, ctx).run(PR);

    const planEvents = trace.ofKind("plan_emitted");
    expect(planEvents).toHaveLength(2);
    expect(planEvents[0]?.plan.goal).toBe("try the risky thing first");
    expect(planEvents[1]?.plan.goal).toBe("back off to a safe call");

    const replan = trace.ofKind("re_plan_triggered");
    expect(replan).toHaveLength(1);
    expect(replan[0]?.reason.kind).toBe("tool_error");
    if (replan[0]?.reason.kind === "tool_error") {
      expect(replan[0].reason.toolName).toBe("explode");
    }

    const observations = trace.ofKind("observation");
    // warm (ok) + explode (error) + fallback (ok)
    expect(observations).toHaveLength(3);
    expect(observations[0]?.observation.outcome.kind).toBe("ok");
    expect(observations[1]?.observation.outcome.kind).toBe("error");
    expect(observations[2]?.observation.outcome.kind).toBe("ok");
  });

  it("distinguishes approval_denied from a generic tool_error in the trace", async () => {
    const denyAll = {
      async requestApproval() {
        return { approved: false, reason: "operator said no" };
      },
    };
    const initial: Plan = {
      goal: "try to post",
      steps: [{ rationale: "send the comment", tool: "post", input: { body: "hi" } }],
    };
    const revised: Plan = {
      goal: "skip posting, just summarize locally",
      steps: [{ rationale: "stay safe", tool: "ping", input: { msg: "noop" } }],
    };
    const planner = new ScriptedPlanner(initial, [() => revised]);
    const trace = new Trace();
    const ctx: ToolContext = {
      mode: "replay",
      fixturesDir: "fixtures/sample-prs",
      approvals: denyAll,
    };

    await new AgentRun(buildRegistry(), planner, trace, ctx).run(PR);

    const replan = trace.ofKind("re_plan_triggered");
    expect(replan).toHaveLength(1);
    expect(replan[0]?.reason.kind).toBe("approval_denied");
    if (replan[0]?.reason.kind === "approval_denied") {
      expect(replan[0].reason.toolName).toBe("post");
    }
  });

  it("aborts cleanly when the re-plan budget is exhausted", async () => {
    // Every plan tries to explode; the planner keeps revising to another
    // plan that also explodes. With maxReplans=2 we should see 1 initial
    // plan + 2 revisions, then an `aborted` event, then `finalized`.
    const explodingPlan = (): Plan => ({
      goal: "keep trying the failing tool",
      steps: [{ rationale: "fail again", tool: "explode", input: {} }],
    });
    const planner = new ScriptedPlanner(
      explodingPlan(),
      [explodingPlan, explodingPlan, explodingPlan, explodingPlan],
      () => ({ summary: "abort", findings: [], recommendation: "request_changes" }),
    );
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    const review = await new AgentRun(buildRegistry(), planner, trace, ctx, {
      maxReplans: 2,
    }).run(PR);

    expect(trace.ofKind("plan_emitted")).toHaveLength(3); // initial + 2 revisions
    expect(trace.ofKind("re_plan_triggered")).toHaveLength(3); // each error triggers a trigger; the last one busts the budget
    expect(trace.ofKind("aborted")).toHaveLength(1);
    expect(trace.ofKind("aborted")[0]?.reason).toContain("max_replans_exceeded");
    expect(trace.ofKind("finalized")).toHaveLength(1);
    expect(review.recommendation).toBe("request_changes");
  });

  it("re-throws non-ToolError exceptions from the registry", async () => {
    // A tool that throws a plain Error simulates a programmer mistake;
    // we don't want the executor swallowing those into re-plan triggers.
    const wildTool: Tool<typeof explodeIn, typeof explodeOut> = {
      name: "wild",
      description: "throws a plain Error",
      inputSchema: explodeIn,
      outputSchema: explodeOut,
      async run() {
        throw new Error("not a ToolError");
      },
    };
    const registry = new ToolRegistry();
    registry.register(wildTool);
    const plan: Plan = {
      goal: "trigger the bug",
      steps: [{ rationale: "boom", tool: "wild", input: {} }],
    };
    const planner = new ScriptedPlanner(plan);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await expect(
      new AgentRun(registry, planner, trace, ctx).run(PR),
    ).rejects.toThrow(/not a ToolError/);
  });
});

// ---------------------------------------------------------------------
// PlannerState shape
// ---------------------------------------------------------------------

describe("AgentRun — PlannerState", () => {
  it("passes accumulated observations to revise()", async () => {
    let capturedObsCount = -1;
    const initial: Plan = {
      goal: "warm + fail",
      steps: [
        { rationale: "ok step", tool: "ping", input: { msg: "ok" } },
        { rationale: "bad step", tool: "explode", input: {} },
      ],
    };
    const planner = new ScriptedPlanner(initial, [
      (state) => {
        capturedObsCount = state.observations.length;
        return { goal: "recover", steps: [] };
      },
    ]);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };
    await new AgentRun(buildRegistry(), planner, trace, ctx).run(PR);
    // Both observations (the OK ping and the failing explode) are present
    // when revise() is called.
    expect(capturedObsCount).toBe(2);
  });

  it("passes accumulated plans (initial + revisions) to finalize()", async () => {
    let capturedPlanCount = -1;
    const initial: Plan = {
      goal: "fail",
      steps: [{ rationale: "boom", tool: "explode", input: {} }],
    };
    const planner = new ScriptedPlanner(
      initial,
      [() => ({ goal: "noop", steps: [] })],
      (state) => {
        capturedPlanCount = state.plans.length;
        return { summary: "x", findings: [], recommendation: "approve" };
      },
    );
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };
    await new AgentRun(buildRegistry(), planner, trace, ctx).run(PR);
    expect(capturedPlanCount).toBe(2); // initial + 1 revision
  });
});

// ---------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------

describe("Trace", () => {
  it("stamps events with the injected clock", async () => {
    let n = 0;
    const trace = new Trace({ clock: () => ++n });
    trace.emit({ kind: "run_started", pr: PR });
    trace.emit({ kind: "aborted", reason: "demo" });
    const events = trace.events();
    expect(events[0]?.ts).toBe(1);
    expect(events[1]?.ts).toBe(2);
  });

  it("returns a defensive copy from events()", () => {
    const trace = new Trace();
    trace.emit({ kind: "aborted", reason: "x" });
    const a = trace.events();
    a.pop();
    expect(trace.events()).toHaveLength(1);
  });

  it("ofKind filters preserving order", () => {
    const trace = new Trace({ clock: () => 1 });
    trace.emit({ kind: "run_started", pr: PR });
    trace.emit({ kind: "aborted", reason: "first" });
    trace.emit({ kind: "aborted", reason: "second" });
    const aborts = trace.ofKind("aborted");
    expect(aborts).toHaveLength(2);
    expect(aborts[0]?.reason).toBe("first");
    expect(aborts[1]?.reason).toBe("second");
  });
});

// ---------------------------------------------------------------------
// Retry + fallback
// ---------------------------------------------------------------------

describe("AgentRun — retry and fallback", () => {
  const noSleep = async (_ms: number): Promise<void> => undefined;

  function makeFlakyTool(name: string, failuresBeforeSuccess: number): Tool<typeof pingIn, typeof pingOut> {
    let calls = 0;
    return {
      name,
      description: "fails N times then succeeds",
      inputSchema: pingIn,
      outputSchema: pingOut,
      annotations: { retry: { maxAttempts: 5, backoffMs: 1 } },
      async run(input) {
        calls += 1;
        if (calls <= failuresBeforeSuccess) {
          throw new ToolError(name, "internal", `transient failure ${calls}`);
        }
        return { pong: `${input.msg}-after-${calls}` };
      },
    };
  }

  it("retries on internal ToolError and surfaces the eventual success", async () => {
    const flaky = makeFlakyTool("flaky", 2);
    const registry = new ToolRegistry();
    registry.register(flaky);
    const plan: Plan = {
      goal: "use the flaky tool",
      steps: [{ rationale: "try once, retries cover the rest", tool: "flaky", input: { msg: "hi" } }],
    };
    const planner = new ScriptedPlanner(plan);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await new AgentRun(registry, planner, trace, ctx, { sleep: noSleep }).run(PR);

    const retries = trace.ofKind("retry_attempted");
    expect(retries).toHaveLength(2);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[0]?.backoffMs).toBe(1);
    expect(retries[1]?.attempt).toBe(2);
    expect(retries[1]?.backoffMs).toBe(2);
    const observations = trace.ofKind("observation");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observation.outcome.kind).toBe("ok");
    expect(trace.ofKind("re_plan_triggered")).toHaveLength(0);
  });

  it("falls back to the declared alternative when the primary's retries are exhausted", async () => {
    const alwaysFails: Tool<typeof pingIn, typeof pingOut> = {
      name: "primary",
      description: "never succeeds",
      inputSchema: pingIn,
      outputSchema: pingOut,
      annotations: {
        retry: { maxAttempts: 2, backoffMs: 1 },
        fallbackTo: "alternate",
      },
      async run() {
        throw new ToolError("primary", "internal", "down");
      },
    };
    const alternate: Tool<typeof pingIn, typeof pingOut> = {
      name: "alternate",
      description: "the standby",
      inputSchema: pingIn,
      outputSchema: pingOut,
      async run(input) {
        return { pong: `alt-${input.msg}` };
      },
    };
    const registry = new ToolRegistry();
    registry.register(alwaysFails);
    registry.register(alternate);

    const plan: Plan = {
      goal: "primary first, fallback transparent to planner",
      steps: [{ rationale: "use the down service", tool: "primary", input: { msg: "x" } }],
    };
    const planner = new ScriptedPlanner(plan);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await new AgentRun(registry, planner, trace, ctx, { sleep: noSleep }).run(PR);

    expect(trace.ofKind("retry_attempted")).toHaveLength(1);
    const fb = trace.ofKind("fallback_used");
    expect(fb).toHaveLength(1);
    expect(fb[0]?.from).toBe("primary");
    expect(fb[0]?.to).toBe("alternate");
    const obs = trace.ofKind("observation");
    expect(obs).toHaveLength(1);
    expect(obs[0]?.observation.outcome.kind).toBe("ok");
    // No replan should have fired — the fallback covered for the primary.
    expect(trace.ofKind("re_plan_triggered")).toHaveLength(0);
  });

  it("only emits one observation per step even when retry + fallback both fire", async () => {
    const flakyA = makeFlakyTool("flakyA", 10); // never succeeds within attempts
    const annotatedA: Tool<typeof pingIn, typeof pingOut> = {
      ...flakyA,
      annotations: { retry: { maxAttempts: 2, backoffMs: 1 }, fallbackTo: "flakyB" },
    };
    const flakyB = makeFlakyTool("flakyB", 1); // succeeds on retry
    const registry = new ToolRegistry();
    registry.register(annotatedA);
    registry.register(flakyB);

    const plan: Plan = {
      goal: "exercise both layers",
      steps: [{ rationale: "see the full recovery stack", tool: "flakyA", input: { msg: "z" } }],
    };
    const planner = new ScriptedPlanner(plan);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await new AgentRun(registry, planner, trace, ctx, { sleep: noSleep }).run(PR);

    // Exactly one observation makes it to the planner: the final success
    // from flakyB's retry. Retries + fallback are visible in the trace
    // for human/UI consumption but don't pollute the planner's input.
    expect(trace.ofKind("observation")).toHaveLength(1);
    expect(trace.ofKind("observation")[0]?.observation.outcome.kind).toBe("ok");
    // 1 retry on flakyA before fallback + 1 retry on flakyB before success.
    expect(trace.ofKind("retry_attempted")).toHaveLength(2);
    expect(trace.ofKind("fallback_used")).toHaveLength(1);
  });

  it("triggers a replan when retry + fallback both exhaust", async () => {
    const allDown: Tool<typeof pingIn, typeof pingOut> = {
      name: "down",
      description: "everything is on fire",
      inputSchema: pingIn,
      outputSchema: pingOut,
      annotations: {
        retry: { maxAttempts: 2, backoffMs: 1 },
        fallbackTo: "downStandby",
      },
      async run() {
        throw new ToolError("down", "internal", "primary out");
      },
    };
    const standby: Tool<typeof pingIn, typeof pingOut> = {
      name: "downStandby",
      description: "also out",
      inputSchema: pingIn,
      outputSchema: pingOut,
      // Standby itself has no retry/fallback — single attempt, then surface.
      async run() {
        throw new ToolError("downStandby", "internal", "secondary out");
      },
    };
    const registry = new ToolRegistry();
    registry.register(allDown);
    registry.register(standby);
    registry.register(pingTool);

    const initial: Plan = {
      goal: "primary path",
      steps: [{ rationale: "primary then standby", tool: "down", input: { msg: "x" } }],
    };
    const revised: Plan = {
      goal: "give up and ping",
      steps: [{ rationale: "safe", tool: "ping", input: { msg: "fallback" } }],
    };
    const planner = new ScriptedPlanner(initial, [() => revised]);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await new AgentRun(registry, planner, trace, ctx, { sleep: noSleep }).run(PR);

    // 1 retry on `down`, then the executor falls back to `downStandby`
    // (no retry annotation → single attempt). Both exhaust → replan fires.
    expect(trace.ofKind("retry_attempted")).toHaveLength(1);
    expect(trace.ofKind("fallback_used")).toHaveLength(1);
    const replans = trace.ofKind("re_plan_triggered");
    expect(replans).toHaveLength(1);
    expect(replans[0]?.reason.kind).toBe("tool_error");
    if (replans[0]?.reason.kind === "tool_error") {
      // The replan reports the *fallback*'s failure, since that's the
      // final outcome the planner sees on the observation.
      expect(replans[0].reason.toolName).toBe("downStandby");
    }
  });

  it("surfaces an internal ToolError when fallbackTo points at a missing tool", async () => {
    const orphan: Tool<typeof pingIn, typeof pingOut> = {
      name: "orphan",
      description: "fallback points nowhere",
      inputSchema: pingIn,
      outputSchema: pingOut,
      annotations: {
        retry: { maxAttempts: 1, backoffMs: 1 },
        fallbackTo: "ghost",
      },
      async run() {
        throw new ToolError("orphan", "internal", "down");
      },
    };
    const registry = new ToolRegistry();
    registry.register(orphan);

    const plan: Plan = {
      goal: "trigger misconfig",
      steps: [{ rationale: "primary down", tool: "orphan", input: { msg: "x" } }],
    };
    const planner = new ScriptedPlanner(plan, [() => ({ goal: "noop", steps: [] })]);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await new AgentRun(registry, planner, trace, ctx, { sleep: noSleep }).run(PR);

    // Misconfig surfaces as a ToolError observation, not a crash.
    const obs = trace.ofKind("observation");
    expect(obs).toHaveLength(1);
    expect(obs[0]?.observation.outcome.kind).toBe("error");
    if (obs[0]?.observation.outcome.kind === "error") {
      expect(obs[0].observation.outcome.error.message).toMatch(/ghost/);
    }
  });

  it("does not follow the fallback's own fallbackTo — one hop only", async () => {
    let standbyCalls = 0;
    const primaryFail: Tool<typeof pingIn, typeof pingOut> = {
      name: "primaryFail",
      description: "always down",
      inputSchema: pingIn,
      outputSchema: pingOut,
      annotations: {
        retry: { maxAttempts: 1, backoffMs: 1 },
        fallbackTo: "secondary",
      },
      async run() {
        throw new ToolError("primaryFail", "internal", "down");
      },
    };
    const secondaryFail: Tool<typeof pingIn, typeof pingOut> = {
      name: "secondary",
      description: "also down, with its own fallback declared",
      inputSchema: pingIn,
      outputSchema: pingOut,
      // This fallbackTo MUST NOT be followed by the executor.
      annotations: { fallbackTo: "tertiary" },
      async run() {
        throw new ToolError("secondary", "internal", "also down");
      },
    };
    const tertiary: Tool<typeof pingIn, typeof pingOut> = {
      name: "tertiary",
      description: "would succeed if reached",
      inputSchema: pingIn,
      outputSchema: pingOut,
      async run(input) {
        standbyCalls += 1;
        return { pong: input.msg };
      },
    };
    const registry = new ToolRegistry();
    registry.register(primaryFail);
    registry.register(secondaryFail);
    registry.register(tertiary);

    const plan: Plan = {
      goal: "ensure single-hop",
      steps: [{ rationale: "x", tool: "primaryFail", input: { msg: "z" } }],
    };
    const planner = new ScriptedPlanner(plan, [() => ({ goal: "noop", steps: [] })]);
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    await new AgentRun(registry, planner, trace, ctx, { sleep: noSleep }).run(PR);

    expect(standbyCalls).toBe(0);
    expect(trace.ofKind("fallback_used")).toHaveLength(1);
    // Observation reports the *secondary*'s failure (the last attempt).
    const obs = trace.ofKind("observation");
    if (obs[0]?.observation.outcome.kind === "error") {
      expect(obs[0].observation.outcome.error.toolName).toBe("secondary");
    }
  });
});

// ---------------------------------------------------------------------
// Integration: real ToolRegistry + buildDefaultRegistry tools on a fixture
// ---------------------------------------------------------------------

describe("AgentRun — integration with the default tool surface", () => {
  it("runs a fetch_pr → finalize plan against the committed rag-production-kit fixture", async () => {
    const { buildDefaultRegistry } = await import("../../src/index.js");
    const registry = buildDefaultRegistry();
    const plan: Plan = {
      goal: "fetch the PR, then summarize what it changed",
      steps: [
        {
          rationale: "load the PR so we can comment on its changed files",
          tool: "fetch_pr",
          input: { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 },
        },
      ],
    };
    const planner = new ScriptedPlanner(plan, [], (state) => {
      const fetchObs = state.observations[0];
      if (!fetchObs || fetchObs.outcome.kind !== "ok") {
        throw new Error("integration fixture missing or schema changed");
      }
      const fixture = fetchObs.outcome.value as { pr: { title: string; changed_files: number } };
      return {
        summary: `Reviewed: ${fixture.pr.title} (${fixture.pr.changed_files} files changed).`,
        findings: [],
        recommendation: "approve_with_comments",
      };
    });
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

    const review = await new AgentRun(registry, planner, trace, ctx).run({
      owner: "jt-mchorse",
      repo: "rag-production-kit",
      number: 9,
    });

    expect(review.summary).toMatch(/Reviewed:/);
    expect(review.recommendation).toBe("approve_with_comments");
    expect(trace.ofKind("plan_emitted")).toHaveLength(1);
    expect(trace.ofKind("re_plan_triggered")).toHaveLength(0);
  });
});
