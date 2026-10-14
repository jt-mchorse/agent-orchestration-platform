/**
 * `aggregateCost` bounds the TOTAL it returns, not only each summand (#205).
 *
 * #143 / D-015 matched each summand to the column its total lands in:
 *
 *     total_cost_dollars  NUMERIC(12, 6)   holds < 10^6
 *     total_input_tokens  BIGINT           Number.isSafeInteger
 *     total_output_tokens BIGINT           Number.isSafeInteger
 *
 * and checked each observation against that domain. The column holds the sum.
 * Measured on Postgres 17 before this fix:
 *
 *     charges                  aggregate   MemoryStore   PgStore
 *     600000 + 600000          1200000     stored        22003 numeric field overflow
 *     999999.9999996           1000000     stored        22003 numeric field overflow
 *     999999.999999            999999.999999 stored      stored
 *
 * The second row is the quiet one: the summand is `< 10^6`, and `quantiseDollars`
 * rounds it UP to exactly `10^6`. The posture is D-015's unchanged: a summand that
 * would carry the total out of the column's domain is SKIPPED, never thrown.
 */

import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { PgStore } from "../../src/trace/pg-store.js";
import { MemoryStore, aggregateCost } from "../../src/trace/store.js";

const PR: PlannerState["pr"] = { owner: "jt-mchorse", repo: "alpha", number: 1 };
const REVIEW: Review = { summary: "s", findings: [], recommendation: "approve" };

type Cost = { input_tokens?: number; output_tokens?: number; dollars?: number };

const observation = (cost: Cost): TraceEvent =>
  ({ ts: 1_700_000_000_000, kind: "observation", observation: { cost } }) as unknown as TraceEvent;

const run = (costs: Cost[]): TraceEvent[] => [
  { ts: 1_700_000_000_000, kind: "run_started", pr: PR } as unknown as TraceEvent,
  ...costs.map(observation),
  { ts: 1_700_000_000_004, kind: "finalized", review: REVIEW } as unknown as TraceEvent,
];

describe("the dollars total fits NUMERIC(12, 6)", () => {
  it("two storable charges that sum past 10^6: the second is skipped", () => {
    expect(aggregateCost([observation({ dollars: 600_000 }), observation({ dollars: 600_000 })]).dollars).toBe(
      600_000,
    );
  });

  it("one charge that quantises UP to 10^6 is skipped", () => {
    expect(aggregateCost([observation({ dollars: 999_999.9999996 })]).dollars).toBe(0);
  });

  it("the largest storable total is kept", () => {
    expect(aggregateCost([observation({ dollars: 999_999.999999 })]).dollars).toBe(999_999.999999);
    expect(
      aggregateCost([observation({ dollars: 500_000 }), observation({ dollars: 499_999.999999 })]).dollars,
    ).toBe(999_999.999999);
  });

  it("a later charge that still fits is added after a skipped one", () => {
    const got = aggregateCost([
      observation({ dollars: 900_000 }),
      observation({ dollars: 200_000 }),
      observation({ dollars: 0.25 }),
    ]);
    expect(got.dollars).toBe(900_000.25);
  });

  it("does not throw: the partial-total posture is unchanged", () => {
    expect(() =>
      aggregateCost([observation({ dollars: 999_999 }), observation({ dollars: 999_999 })]),
    ).not.toThrow();
  });
});

describe("the token totals stay safe integers", () => {
  it("a count that would carry the sum past MAX_SAFE_INTEGER is skipped", () => {
    const got = aggregateCost([
      observation({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER }),
      observation({ input_tokens: 2, output_tokens: 2 }),
    ]);
    expect(Number.isSafeInteger(got.input_tokens)).toBe(true);
    expect(Number.isSafeInteger(got.output_tokens)).toBe(true);
    expect(got.input_tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(got.output_tokens).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("ordinary counts still sum", () => {
    const got = aggregateCost([
      observation({ input_tokens: 10, output_tokens: 3 }),
      observation({ input_tokens: 5, output_tokens: 4 }),
    ]);
    expect(got.input_tokens).toBe(15);
    expect(got.output_tokens).toBe(7);
  });
});

describe("both backends store a total the column can hold", () => {
  async function pgDollarsParam(events: TraceEvent[]): Promise<number> {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      async query(sql: string, params: unknown[]) {
        captured.push({ sql, params });
        return { rows: [] };
      },
      async end() {},
      async connect() {
        const query = this.query.bind(this);
        return { query, release() {} };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new PgStore({ pool: pool as any });
    await store.writeRun({ run_id: "r1", pr: PR, review: REVIEW, events });
    const insert = captured.find((c) => c.sql.includes("INSERT INTO runs"));
    expect(insert, "writeRun emitted no INSERT INTO runs").toBeTruthy();
    // Column order in the INSERT: ..., status, total_cost_dollars, ...
    return insert!.params[7] as number;
  }

  it.each([
    ["600000 + 600000", [600_000, 600_000]],
    ["999999.9999996", [999_999.9999996]],
  ])("%s: the same storable dollars in MemoryStore and in PgStore's INSERT", async (_label, charges) => {
    const events = run(charges.map((dollars) => ({ dollars })));
    const memory = new MemoryStore();
    await memory.writeRun({ run_id: "r1", pr: PR, review: REVIEW, events });
    const fromMemory = (await memory.getRun("r1"))!.total_cost.dollars;
    const fromPg = await pgDollarsParam(events);
    expect(fromPg).toBe(fromMemory);
    expect(fromPg).toBeLessThan(1_000_000);
  });
});
