// A zero `backoffMs` turned into `NaN` once the power overflowed (#211).
//
// The schedule is `backoffMs * multiplier ** (attempt - 1)`. #122 bounded that
// product from above, so the sleep could never exceed Node's timer limit. It
// did not consider the one product that is not a number: with `backoffMs: 0`,
// once `multiplier ** n` overflows to `Infinity`, `0 * Infinity` is `NaN`.
// Measured on `main` @ 8b02ad9:
//
//   { maxAttempts: 4,    backoffMs: 0, backoffMultiplier: 1e300 }  NaN at attempt 3
//   { maxAttempts: 1100, backoffMs: 0 }                            NaN at attempt 1025
//   { maxAttempts: 1100, backoffMs: 0, backoffMaxMs: 1000 }        NaN at attempt 1025
//
// `NaN > MAX_TIMER_MS` and `NaN > backoffMaxMs` are both false, so the peak
// check accepted the policy and the cap did not bound it. The loop then slept
// `NaN` (Node: a 1 ms timer plus a `TimeoutNaNWarning`) and reported
// `backoffMs: NaN` to `onAttempt`, which the executor emits as a
// `retry_attempted` event and both trace stores serialise as `null`.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentRun } from "../../src/agent/executor.js";
import { ScriptedPlanner } from "../../src/agent/planner.js";
import { withRetry } from "../../src/agent/retry.js";
import { Trace } from "../../src/agent/trace.js";
import { MemoryStore } from "../../src/trace/store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ToolError, type RetryPolicy, type Tool, type ToolContext } from "../../src/tools/types.js";

/** Fails `maxAttempts - 1` times, then succeeds, recording every sleep and report. */
async function runToSuccess(
  policy: RetryPolicy,
): Promise<{ slept: number[]; reported: number[] }> {
  const slept: number[] = [];
  const reported: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls += 1;
      if (calls < policy.maxAttempts) throw new ToolError("probe-tool", "internal", "transient");
      return "ok";
    },
    policy,
    (a) => void reported.push(a.backoffMs),
    async (ms) => void slept.push(ms),
  );
  return { slept, reported };
}

describe("withRetry: a zero backoffMs stays zero at every attempt (#211)", () => {
  const cases: Array<[string, RetryPolicy]> = [
    ["a huge multiplier overflows by attempt 3", { maxAttempts: 4, backoffMs: 0, backoffMultiplier: 1e300 }],
    ["the default multiplier overflows at attempt 1025", { maxAttempts: 1100, backoffMs: 0 }],
    ["a valid backoffMaxMs does not mask it", { maxAttempts: 1100, backoffMs: 0, backoffMaxMs: 1000 }],
    ["full jitter of zero is zero", { maxAttempts: 1100, backoffMs: 0, jitter: "full" }],
  ];

  for (const [name, policy] of cases) {
    it(`${name}: every sleep and every reported backoff is exactly 0`, async () => {
      const { slept, reported } = await runToSuccess(policy);
      expect(slept).toHaveLength(policy.maxAttempts - 1);
      expect(reported).toHaveLength(policy.maxAttempts - 1);
      expect(slept.filter((ms) => ms !== 0)).toEqual([]);
      expect(reported.filter((ms) => ms !== 0)).toEqual([]);
    });
  }

  it("a non-zero schedule is unchanged", async () => {
    const { slept, reported } = await runToSuccess({ maxAttempts: 5, backoffMs: 10, backoffMultiplier: 3 });
    expect(slept).toEqual([10, 30, 90, 270]);
    expect(reported).toEqual(slept);
  });

  it("a non-zero base whose schedule overflows is still refused", async () => {
    await expect(
      runToSuccess({ maxAttempts: 4, backoffMs: 1, backoffMultiplier: 1e300 }),
    ).rejects.toThrow(RangeError);
  });
});

describe("the persisted trace records 0, not null, for a zero-base retry (#211)", () => {
  it("retry_attempted.backoffMs survives a MemoryStore round trip as 0", async () => {
    const pingIn = z.object({ msg: z.string().min(1) });
    const pingOut = z.object({ pong: z.string() });
    let calls = 0;
    const flaky: Tool<typeof pingIn, typeof pingOut> = {
      name: "flaky",
      description: "fails three times then succeeds",
      inputSchema: pingIn,
      outputSchema: pingOut,
      annotations: { retry: { maxAttempts: 4, backoffMs: 0, backoffMultiplier: 1e300 } },
      async run(input) {
        calls += 1;
        if (calls < 4) throw new ToolError("flaky", "internal", `transient ${calls}`);
        return { pong: input.msg };
      },
    };
    const registry = new ToolRegistry();
    registry.register(flaky);
    const pr = { owner: "jt-mchorse", repo: "test", number: 1 };
    const planner = new ScriptedPlanner({
      goal: "use the flaky tool",
      steps: [{ rationale: "retries cover it", tool: "flaky", input: { msg: "hi" } }],
    });
    const trace = new Trace();
    const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };
    const review = await new AgentRun(registry, planner, trace, ctx, {
      sleep: async () => undefined,
    }).run(pr);

    const store = new MemoryStore();
    await store.writeRun({ run_id: "zero-base", pr, events: trace.events(), review });
    const stored = await store.getRun("zero-base");
    const backoffs = stored!.events
      .filter((e) => e.kind === "retry_attempted")
      .map((e) => (e as { backoffMs: unknown }).backoffMs);
    expect(backoffs).toEqual([0, 0, 0]);
  });
});
