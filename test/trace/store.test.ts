import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { aggregateCost, MemoryStore } from "../../src/trace/store.js";

const PR: PlannerState["pr"] = { owner: "jt-mchorse", repo: "test", number: 1 };

function review(overrides: Partial<Review> = {}): Review {
  return {
    summary: "sample summary",
    findings: [],
    recommendation: "approve",
    ...overrides,
  };
}

function buildCost(input?: number, output?: number, dollars?: number): Record<string, number> {
  // exactOptionalPropertyTypes is on, so we only put keys we actually want;
  // an absent field stays absent rather than being set to `undefined`.
  const cost: Record<string, number> = {};
  if (input !== undefined) cost.input_tokens = input;
  if (output !== undefined) cost.output_tokens = output;
  if (dollars !== undefined) cost.dollars = dollars;
  return cost;
}

function obs(
  toolName: string,
  ok: boolean,
  cost?: { input?: number; output?: number; dollars?: number },
): TraceEvent {
  const step = { rationale: "r", tool: toolName, input: {} };
  const costObj = cost ? buildCost(cost.input, cost.output, cost.dollars) : undefined;
  if (ok) {
    const observation: TraceEvent extends infer T ? T : never = {} as never;
    void observation;
    return {
      ts: 1,
      kind: "observation",
      observation: costObj
        ? { step, outcome: { kind: "ok", value: { x: 1 } }, cost: costObj }
        : { step, outcome: { kind: "ok", value: { x: 1 } } },
    };
  }
  const errorBody = {
    step,
    // ToolError serialized into the trace via writeRun usually; for the
    // unit-level cost test we mimic the runtime shape.
    outcome: {
      kind: "error" as const,
      error: { name: "ToolError", kind: "internal", toolName, message: "x" } as never,
    },
  };
  return {
    ts: 1,
    kind: "observation",
    observation: costObj ? { ...errorBody, cost: costObj } : errorBody,
  };
}

// -------------------------------------------------------------
// aggregateCost
// -------------------------------------------------------------

describe("aggregateCost", () => {
  it("sums each cost field across observation events", () => {
    const events: TraceEvent[] = [
      obs("a", true, { input: 100, output: 50, dollars: 0.001 }),
      obs("b", true, { input: 200, output: 75, dollars: 0.002 }),
      obs("c", true, { input: 0, output: 0, dollars: 0 }),
    ];
    expect(aggregateCost(events)).toEqual({
      input_tokens: 300,
      output_tokens: 125,
      dollars: 0.003,
    });
  });

  it("treats absent cost as 'unknown', not zero, and skips it cleanly", () => {
    const events: TraceEvent[] = [
      obs("a", true), // no cost reported
      obs("b", true, { input: 100, output: 50, dollars: 0.01 }),
    ];
    expect(aggregateCost(events)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      dollars: 0.01,
    });
  });

  it("returns all zeros when no observation reports cost", () => {
    const events: TraceEvent[] = [
      obs("a", true),
      obs("b", false),
    ];
    expect(aggregateCost(events)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      dollars: 0,
    });
  });

  it("ignores non-observation events even if they look cost-shaped", () => {
    const events: TraceEvent[] = [
      { ts: 1, kind: "run_started", pr: PR },
      { ts: 2, kind: "aborted", reason: "no_cost_should_count_here" },
    ];
    expect(aggregateCost(events)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      dollars: 0,
    });
  });

  it("skips partial cost fields (some present, some absent)", () => {
    const events: TraceEvent[] = [
      obs("a", true, { input: 100 }),                     // dollars absent
      obs("b", true, { output: 50, dollars: 0.005 }),    // input absent
    ];
    expect(aggregateCost(events)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      dollars: 0.005,
    });
  });

  it("counts cost from failed observations too — the LLM was still called", () => {
    const events: TraceEvent[] = [
      obs("a", false, { input: 100, output: 0, dollars: 0.0005 }),
    ];
    expect(aggregateCost(events).dollars).toBeCloseTo(0.0005, 6);
  });

  // `typeof NaN === "number"` is true, so a bare typeof guard let a corrupt
  // value poison the whole run's aggregate (`x += NaN` → NaN). Non-finite and
  // negative costs are skipped like an absent field — a partial total, never a
  // corrupt one — matching the repo's finite-and-non-negative contract.
  it.each([NaN, Infinity, -Infinity, -5])(
    "skips a corrupt cost value (%p) instead of poisoning the aggregate",
    (bad) => {
      const events: TraceEvent[] = [
        obs("a", true, { input: 100, output: 50, dollars: 0.01 }),
        obs("b", true, { input: bad, output: bad, dollars: bad }),
      ];
      // The corrupt observation's fields are dropped; the good one survives intact.
      expect(aggregateCost(events)).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        dollars: 0.01,
      });
    },
  );

  it("drops only the corrupt field, keeping the valid fields of the same observation", () => {
    const events: TraceEvent[] = [
      obs("a", true, { input: 100, output: NaN, dollars: 0.02 }),
    ];
    expect(aggregateCost(events)).toEqual({
      input_tokens: 100,
      output_tokens: 0, // NaN skipped
      dollars: 0.02,
    });
  });
});

// -------------------------------------------------------------
// MemoryStore
// -------------------------------------------------------------

function makeRunEvents(): TraceEvent[] {
  return [
    { ts: 1, kind: "run_started", pr: PR },
    {
      ts: 2,
      kind: "plan_emitted",
      plan: { goal: "ping", steps: [{ rationale: "r", tool: "ping", input: {} }] },
      version: 0,
    },
    {
      ts: 3,
      kind: "step_started",
      step: { rationale: "r", tool: "ping", input: {} },
      index: 0,
    },
    obs("ping", true, { input: 50, output: 10, dollars: 0.0002 }),
    {
      ts: 5,
      kind: "finalized",
      review: review(),
    },
  ];
}

describe("MemoryStore", () => {
  it("writes and reads a single run round-trip", async () => {
    const store = new MemoryStore();
    await store.writeRun({
      run_id: "r-1",
      pr: PR,
      events: makeRunEvents(),
      review: review(),
    });
    const detail = await store.getRun("r-1");
    expect(detail).not.toBeNull();
    expect(detail?.run_id).toBe("r-1");
    expect(detail?.events).toHaveLength(5);
    expect(detail?.total_cost.dollars).toBeCloseTo(0.0002, 6);
    expect(detail?.status).toBe("finalized");
    expect(detail?.recommendation).toBe("approve");
  });

  it("returns null for a missing run id", async () => {
    const store = new MemoryStore();
    expect(await store.getRun("nope")).toBeNull();
  });

  it("listRuns is sorted started_at DESC and paginates", async () => {
    const store = new MemoryStore();
    // Three runs with deliberately separated started_at timestamps.
    for (let i = 0; i < 3; i += 1) {
      await store.writeRun({
        run_id: `r-${i}`,
        pr: PR,
        events: [
          // started_at derived from the run_started event's `ts` ms epoch.
          // Use 1_700_000_000_000 + i * 1000 so newest-first ordering is obvious.
          { ts: 1_700_000_000_000 + i * 1000, kind: "run_started", pr: PR },
          {
            ts: 1_700_000_000_001 + i * 1000,
            kind: "finalized",
            review: review(),
          },
        ],
        review: review(),
      });
    }
    const all = await store.listRuns();
    expect(all.map((r) => r.run_id)).toEqual(["r-2", "r-1", "r-0"]);
    const page = await store.listRuns({ limit: 2, offset: 1 });
    expect(page.map((r) => r.run_id)).toEqual(["r-1", "r-0"]);
  });

  it("derives status = aborted when events contain an aborted entry", async () => {
    const store = new MemoryStore();
    await store.writeRun({
      run_id: "r-x",
      pr: PR,
      events: [
        { ts: 1, kind: "run_started", pr: PR },
        { ts: 2, kind: "aborted", reason: "max_replans_exceeded:5" },
        { ts: 3, kind: "finalized", review: review() },
      ],
      review: review(),
    });
    const detail = await store.getRun("r-x");
    expect(detail?.status).toBe("aborted");
  });

  it("listRuns returns a defensive copy without events (smaller payload)", async () => {
    const store = new MemoryStore();
    await store.writeRun({
      run_id: "r-1",
      pr: PR,
      events: makeRunEvents(),
      review: review(),
    });
    const list = await store.listRuns();
    expect(list).toHaveLength(1);
    // Confirm `events` is intentionally elided from the list payload.
    expect((list[0] as { events?: unknown }).events).toBeUndefined();
  });
});
