/**
 * `aggregateCost`'s guards must match the columns its output lands in (#143, D-015).
 *
 * `isCountableCost` was one predicate -- `Number.isFinite(x) && x >= 0` -- for three
 * summands with three different destinations, from `infra/postgres/init.sql`:
 *
 *     total_cost_dollars  NUMERIC(12, 6) NOT NULL DEFAULT 0,
 *     total_input_tokens  BIGINT         NOT NULL DEFAULT 0,
 *     total_output_tokens BIGINT         NOT NULL DEFAULT 0,
 *
 * Measured against those domains before the fix:
 *
 *     input                                      accepted?  storable?
 *     integral tokens (the ordinary case)         yes        yes
 *     FRACTIONAL input_tokens   (1234.5678)       yes        NO (tokens)
 *     FRACTIONAL output_tokens  (0.5)             yes        NO (tokens)
 *     dollars with 9 decimals   (1.23e-7)         yes        NO (dollars, ROUNDED)
 *     dollars >= 1e6            (1_000_000)       yes        NO (dollars, overflow)
 *     token count beyond BIGINT (1e19)            yes        NO (tokens)
 *
 * This is the sibling of #141, one function above the fix it landed, and #142's own
 * reasoning transfers verbatim: "`Number.isSafeInteger` is what `BIGINT` receives
 * exactly [...] a failure visible only in the `DATABASE_URL`-gated job".
 *
 * The two halves get different treatment on purpose, and that is the substance:
 *
 *   * A fractional TOKEN count is corrupt data -- tokens are counted, not measured --
 *     so it is skipped, matching this aggregator's documented "partial total" posture.
 *   * A sub-microcent DOLLAR charge is real money. Skipping it, or rounding each
 *     observation to the column's scale, both lose it. So dollars are summed at full
 *     precision and the TOTAL is quantised once (D-015) -- which is also what makes
 *     the two backends store the same number, the requirement #139/#140 moved the
 *     derivations into one definition for.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { PgStore } from "../../src/trace/pg-store.js";
import { MemoryStore, aggregateCost } from "../../src/trace/store.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT_SQL = readFileSync(resolve(ROOT, "infra/postgres/init.sql"), "utf8");

const PR: PlannerState["pr"] = { owner: "jt-mchorse", repo: "alpha", number: 1 };
const REVIEW: Review = { summary: "s", findings: [], recommendation: "approve" };

type Cost = { input_tokens?: number; output_tokens?: number; dollars?: number };

const observation = (cost: Cost): TraceEvent =>
  ({ ts: 1_700_000_000_000, kind: "observation", observation: { cost } }) as unknown as TraceEvent;

// --- the constants are the schema's, not a second copy -----------------------

describe("the guard's bounds are the DDL's bounds", () => {
  it("total_input_tokens and total_output_tokens are BIGINT in init.sql", () => {
    // If the schema moves to NUMERIC or INTEGER, the safe-integer rule is no longer
    // the right one and this test is where that conversation starts.
    for (const column of ["total_input_tokens", "total_output_tokens"]) {
      expect(INIT_SQL, `${column} is not declared BIGINT`).toMatch(
        new RegExp(`${column}\\s+BIGINT`, "i"),
      );
    }
  });

  it("total_cost_dollars is NUMERIC(12, 6), which is where 6 and 10^6 come from", () => {
    const match = INIT_SQL.match(/total_cost_dollars\s+NUMERIC\(\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    expect(match, "total_cost_dollars is not a NUMERIC(p, s)").toBeTruthy();
    const precision = Number(match![1]);
    const scale = Number(match![2]);
    expect(scale, "the quantisation scale in store.ts is 6").toBe(6);
    expect(10 ** (precision - scale), "the magnitude bound in store.ts is 10^6").toBe(1_000_000);
  });
});

// --- tokens: skipped unless BIGINT can hold them exactly ---------------------

describe("token counts are skipped unless BIGINT holds them exactly", () => {
  it.each([
    ["fractional", 1234.5678],
    ["a half token", 0.5],
    ["beyond the safe integers", 1e19],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("skips a %s input_tokens", (_label, value) => {
    const got = aggregateCost([observation({ input_tokens: value, output_tokens: 7 })]);
    expect(got.input_tokens).toBe(0);
    // The partial-total posture: the sibling field still counts.
    expect(got.output_tokens).toBe(7);
  });

  it("counts an integral token value, including zero and a large safe integer", () => {
    const got = aggregateCost([
      observation({ input_tokens: 0, output_tokens: 1200 }),
      observation({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }),
    ]);
    expect(got.input_tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(got.output_tokens).toBe(1201);
  });
});

// --- dollars: summed at full precision, quantised once -----------------------

describe("dollars keep sub-microcent charges and are quantised once", () => {
  it("a single sub-microcent charge is summed, and the COLUMN is what cannot hold it", () => {
    // Measured correction to my own reasoning, caught by this test (#143).
    //
    // I expected the quantised total to keep a lone `1.23e-7`. It cannot:
    // `NUMERIC(12, 6)` has no representation for a value below 5e-7, so the
    // quantised total is `0` — and it would be `0` in the column whether or not
    // this aggregator quantised. The value is not SKIPPED (it enters the sum); the
    // column's scale is the limit.
    //
    // That distinction is the whole benefit, and the next test is what demonstrates
    // it: skipping loses the charge from the SUM, so ten thousand of them would
    // still be zero. Summing then quantising keeps them.
    const lone = aggregateCost([observation({ dollars: 1.23e-7 })]);
    expect(lone.dollars).toBe(0);

    // Not skipped: add one storable charge and the tiny one is part of the sum that
    // gets quantised, rather than having been dropped before it.
    const withFloor = aggregateCost([
      observation({ dollars: 1.23e-7 }),
      observation({ dollars: 0.0000005 }),
    ]);
    expect(withFloor.dollars).toBeGreaterThan(0);
  });

  it("the 6-decimal floor is a property of the schema, and it is written down", () => {
    // A cost report in this repo cannot represent a single charge below 5e-7
    // dollars. That is `NUMERIC(12, 6)`'s scale, not a guard's choice, and widening
    // it is a schema decision rather than part of #143. Pinned so the limitation is
    // a known one rather than a surprise, and so changing the column forces a
    // deliberate visit here.
    const match = INIT_SQL.match(/total_cost_dollars\s+NUMERIC\(\s*\d+\s*,\s*(\d+)\s*\)/i);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(6);
    expect(aggregateCost([observation({ dollars: 4.9e-7 })]).dollars).toBe(0);
    expect(aggregateCost([observation({ dollars: 5.1e-7 })]).dollars).toBeGreaterThan(0);
  });

  it("many sub-microcent charges sum to a number the column can hold", () => {
    // 10_000 x 1e-7 = 1e-3. Rounding EACH observation to 6 decimals would give
    // zero; summing then rounding gives the tenth of a cent that belongs in the
    // report. This is the test that separates "quantise the total" from
    // "quantise each summand".
    const events = Array.from({ length: 10_000 }, () => observation({ dollars: 1e-7 }));
    expect(aggregateCost(events).dollars).toBeCloseTo(0.001, 9);
  });

  it("the total carries at most the column's scale", () => {
    const got = aggregateCost([observation({ dollars: 0.1234567891 })]);
    const decimals = String(got.dollars).split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });

  it("skips an individually unstorable magnitude but keeps the rest", () => {
    const got = aggregateCost([
      observation({ dollars: 1_000_000 }),
      observation({ dollars: 0.25 }),
    ]);
    expect(got.dollars).toBe(0.25);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ])("still skips a %s dollars", (_label, value) => {
    expect(aggregateCost([observation({ dollars: value })]).dollars).toBe(0);
  });
});

// --- the parity requirement #139/#140 exists for -----------------------------

describe("both backends persist the same dollars", () => {
  /** Drive the real `PgStore.writeRun` and return the params it would send. */
  async function pgInsertParams(events: TraceEvent[]): Promise<unknown[]> {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      async query(sql: string, params: unknown[]) {
        captured.push({ sql, params });
        return { rows: [] };
      },
      async end() {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new PgStore({ pool: pool as any });
    await store.writeRun({ run_id: "r1", pr: PR, review: REVIEW, events });
    const insert = captured.find((c) => c.sql.includes("INSERT INTO runs"));
    expect(insert, "writeRun emitted no INSERT INTO runs").toBeTruthy();
    return insert!.params;
  }

  it("a 9-decimal dollars value is the same number in both stores", async () => {
    // Before #143 `MemoryStore` kept the full-precision float and `PgStore` handed it
    // to a NUMERIC(12, 6) column, which rounds silently — so `getRun` returned a
    // different `dollars` depending on which backend answered. Quantising in the
    // shared aggregator is what closes that, and this is the arm that sees it.
    const events = [
      { ts: 1_700_000_000_000, kind: "run_started", pr: PR } as unknown as TraceEvent,
      observation({ dollars: 0.1234567891 }),
      { ts: 1_700_000_000_004, kind: "finalized", review: REVIEW } as unknown as TraceEvent,
    ];
    const memory = new MemoryStore();
    await memory.writeRun({ run_id: "r1", pr: PR, review: REVIEW, events });
    const fromMemory = (await memory.getRun("r1"))!.total_cost.dollars;

    const params = await pgInsertParams(events);
    // Column order in the INSERT: ..., status, total_cost_dollars, ...
    const fromPg = params[7] as number;

    expect(fromPg).toBe(fromMemory);
    // And the value both store is within the column's scale, so Postgres will not
    // round it on the way in — which is what makes "the same number" survive a
    // round trip rather than only matching at the call.
    expect(Number(fromPg.toFixed(6))).toBe(fromPg);
  });

  it("the value PgStore sends for tokens is an integer", async () => {
    const events = [
      { ts: 1_700_000_000_000, kind: "run_started", pr: PR } as unknown as TraceEvent,
      observation({ input_tokens: 1234.5678, output_tokens: 99 }),
      { ts: 1_700_000_000_004, kind: "finalized", review: REVIEW } as unknown as TraceEvent,
    ];
    const params = await pgInsertParams(events);
    const input = params[8] as number;
    const output = params[9] as number;
    expect(Number.isSafeInteger(input), `total_input_tokens ${input} is not a safe integer`).toBe(
      true,
    );
    expect(Number.isSafeInteger(output)).toBe(true);
    // The fractional one was skipped; the integral sibling survived.
    expect(input).toBe(0);
    expect(output).toBe(99);
  });
});

// --- the posture must not have changed --------------------------------------

describe("the skip posture is unchanged", () => {
  it("no guard throws — a corrupt observation yields a partial total", () => {
    // `assertEventTs` throws; this aggregator skips, deliberately, because an
    // aggregate over many observations should degrade to a partial total rather than
    // abort a whole run's write. #143 narrows the skip and must not add a throw.
    expect(() =>
      aggregateCost([
        observation({ input_tokens: Number.NaN, output_tokens: 0.5, dollars: Number.NaN }),
        observation({ input_tokens: 10, output_tokens: 20, dollars: 0.5 }),
      ]),
    ).not.toThrow();
    const got = aggregateCost([
      observation({ input_tokens: Number.NaN, output_tokens: 0.5, dollars: Number.NaN }),
      observation({ input_tokens: 10, output_tokens: 20, dollars: 0.5 }),
    ]);
    expect(got).toEqual({ input_tokens: 10, output_tokens: 20, dollars: 0.5 });
  });

  it("an absent cost is skipped, not treated as zero-with-a-value", () => {
    expect(aggregateCost([observation({})])).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      dollars: 0,
    });
  });

  it("no observations at all gives all zeros", () => {
    expect(aggregateCost([])).toEqual({ input_tokens: 0, output_tokens: 0, dollars: 0 });
  });
});
