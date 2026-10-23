import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentRun } from "../../src/agent/executor.js";
import { ScriptedPlanner } from "../../src/agent/planner.js";
import { Trace } from "../../src/agent/trace.js";
import type { Plan } from "../../src/agent/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  ToolError,
  type RetryPolicy,
  type Tool,
  type ToolContext,
  type ToolErrorKind,
} from "../../src/tools/types.js";

// #263: #240 made `withRetry` refuse the approval kinds whatever the policy
// lists, but a policy listing `output_validation` was still honoured. For a
// destructive tool that re-ran the committed side effect on every attempt and
// once more through the #95 fallback gate, which also trusted the policy:
// 4 approval prompts and 4 side effects for one planned step.

const PR = { owner: "jt-mchorse", repo: "test", number: 1 };
const noSleep = async (_ms: number): Promise<void> => undefined;

const postIn = z.object({ body: z.string().min(1) });
const postOut = z.object({ id: z.number() });

interface Spec {
  /** Primary is destructive (requires approval). */
  destructive: boolean;
  /** Error the primary produces: a bad output shape, or a thrown internal. */
  fails: "output_validation" | "internal";
  retry?: RetryPolicy;
  /** Register `altPost` and point the primary's `fallbackTo` at it. */
  fallback?: boolean;
  /** How `altPost` behaves when it runs. */
  altFails?: "output_validation";
  altRetry?: RetryPolicy;
}

function run(spec: Spec) {
  const sideEffects: string[] = [];
  let prompts = 0;
  const post: Tool<typeof postIn, typeof postOut> = {
    name: "post",
    description: "commits a side effect, then fails as configured",
    inputSchema: postIn,
    outputSchema: postOut,
    annotations: {
      ...(spec.destructive
        ? { destructive: true, destructiveReason: "post a public comment" }
        : {}),
      ...(spec.retry ? { retry: spec.retry } : {}),
      ...(spec.fallback ? { fallbackTo: "altPost" } : {}),
    },
    async run(input) {
      if (spec.fails === "internal") throw new ToolError("post", "internal", "flaky");
      sideEffects.push(`post: ${input.body}`);
      // Wrong shape: the registry throws output_validation AFTER run() committed.
      return { id: "not-a-number" } as unknown as { id: number };
    },
  };
  const altPost: Tool<typeof postIn, typeof postOut> = {
    name: "altPost",
    description: "the destructive alternate",
    inputSchema: postIn,
    outputSchema: postOut,
    annotations: {
      destructive: true,
      destructiveReason: "post a public comment via the alternate path",
      ...(spec.altRetry ? { retry: spec.altRetry } : {}),
    },
    async run(input) {
      sideEffects.push(`altPost: ${input.body}`);
      if (spec.altFails === "output_validation") {
        return { id: "nope" } as unknown as { id: number };
      }
      return { id: 1 };
    },
  };
  const registry = new ToolRegistry();
  registry.register(post);
  if (spec.fallback) registry.register(altPost);

  const initial: Plan = {
    goal: "post the review",
    steps: [{ rationale: "send it", tool: "post", input: { body: "LGTM" } }],
  };
  const planner = new ScriptedPlanner(initial, [() => ({ goal: "give up", steps: [] })]);
  const trace = new Trace();
  const ctx: ToolContext = {
    mode: "replay",
    fixturesDir: "fixtures/sample-prs",
    approvals: {
      async requestApproval() {
        prompts += 1;
        return { approved: true };
      },
    },
  };
  return {
    go: () => new AgentRun(registry, planner, trace, ctx, { sleep: noSleep }).run(PR),
    trace,
    sideEffects,
    prompts: () => prompts,
    outcome: () => trace.ofKind("observation")[0]?.observation.outcome,
  };
}

const LISTS_OV = (maxAttempts = 3): RetryPolicy => ({
  maxAttempts,
  backoffMs: 0,
  retryableErrorKinds: ["internal", "output_validation"] satisfies ToolErrorKind[],
});

function expectErrorKind(
  outcome: ReturnType<ReturnType<typeof run>["outcome"]>,
  kind: ToolErrorKind,
  toolName: string,
): void {
  expect(outcome?.kind).toBe("error");
  if (outcome?.kind === "error") {
    expect(outcome.error.kind).toBe(kind);
    expect(outcome.error.toolName).toBe(toolName);
  }
}

describe("destructive tool + output_validation is never retried or fallen back (#263)", () => {
  it("the issue's repro: 1 prompt, 1 side effect, and the output_validation error surfaces", async () => {
    const r = run({ destructive: true, fails: "output_validation", retry: LISTS_OV(), fallback: true });
    await r.go();
    expect(r.prompts()).toBe(1);
    expect(r.sideEffects).toEqual(["post: LGTM"]);
    expect(r.trace.ofKind("retry_attempted")).toHaveLength(0);
    expect(r.trace.ofKind("fallback_used")).toHaveLength(0);
    expectErrorKind(r.outcome(), "output_validation", "post");
  });

  it("no retry: without a fallback the side effect still runs once, not maxAttempts times", async () => {
    const r = run({ destructive: true, fails: "output_validation", retry: LISTS_OV() });
    await r.go();
    expect(r.sideEffects).toEqual(["post: LGTM"]);
    expect(r.trace.ofKind("retry_attempted")).toHaveLength(0);
    expectErrorKind(r.outcome(), "output_validation", "post");
  });

  it("no fallback: at maxAttempts 1 (no retry possible) the #95 gate alone must refuse the fallback", async () => {
    const r = run({ destructive: true, fails: "output_validation", retry: LISTS_OV(1), fallback: true });
    await r.go();
    expect(r.sideEffects).toEqual(["post: LGTM"]);
    expect(r.trace.ofKind("fallback_used")).toHaveLength(0);
    expectErrorKind(r.outcome(), "output_validation", "post");
  });

  it("the fallback tool's own retry is narrowed too: a destructive altPost listing output_validation runs once", async () => {
    // The primary fails `internal` (legitimately exhausted), so the fallback
    // runs; it then commits its side effect and fails its outputSchema.
    const r = run({
      destructive: true,
      fails: "internal",
      retry: { maxAttempts: 2, backoffMs: 0 },
      fallback: true,
      altFails: "output_validation",
      altRetry: LISTS_OV(),
    });
    await r.go();
    expect(r.sideEffects).toEqual(["altPost: LGTM"]);
    expect(r.trace.ofKind("retry_attempted").filter((e) => e.toolName === "altPost")).toHaveLength(0);
    expectErrorKind(r.outcome(), "output_validation", "altPost");
  });
});

describe("controls: what #263 must not change", () => {
  it("control: a NON-destructive tool listing output_validation still retries and falls back", async () => {
    const r = run({ destructive: false, fails: "output_validation", retry: LISTS_OV(), fallback: true });
    await r.go();
    expect(r.sideEffects).toEqual(["post: LGTM", "post: LGTM", "post: LGTM", "altPost: LGTM"]);
    expect(r.trace.ofKind("retry_attempted")).toHaveLength(2);
    expect(r.trace.ofKind("fallback_used")).toHaveLength(1);
    expect(r.outcome()?.kind).toBe("ok");
  });

  it("control: internal still retries for a destructive tool and still falls back", async () => {
    const r = run({ destructive: true, fails: "internal", retry: LISTS_OV(), fallback: true });
    await r.go();
    expect(r.trace.ofKind("retry_attempted")).toHaveLength(2);
    expect(r.trace.ofKind("fallback_used")).toHaveLength(1);
    // 3 approvals on the primary (each attempt is approved, then throws), 1 on altPost.
    expect(r.prompts()).toBe(4);
    expect(r.sideEffects).toEqual(["altPost: LGTM"]);
    expect(r.outcome()?.kind).toBe("ok");
  });

  it("control: a destructive tool on the default policy already runs once (unchanged)", async () => {
    const r = run({ destructive: true, fails: "output_validation", fallback: true });
    await r.go();
    expect(r.prompts()).toBe(1);
    expect(r.sideEffects).toEqual(["post: LGTM"]);
    expectErrorKind(r.outcome(), "output_validation", "post");
  });
});
