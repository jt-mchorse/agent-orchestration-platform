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
