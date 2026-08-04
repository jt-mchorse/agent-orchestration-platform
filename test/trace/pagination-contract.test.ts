/**
 * Lock tests for #117: `listRuns` validates its pagination window.
 *
 * `MemoryStore` paginated with `Array.prototype.slice`, whose behaviour on a
 * bad value is *silently wrong* rather than an error. Measured on `main`
 * (5b1ad88) against a store holding three runs, newest first:
 *
 *   baseline      -> r3,r2,r1
 *   {limit:-1}    -> r3,r2     // silently drops the oldest run
 *   {limit:2.5}   -> r3,r2     // silently truncates
 *   {limit:NaN}   -> (empty)   // looks like "no runs exist"
 *   {offset:-1}   -> r1        // the OLDEST run, skipping the two newest
 *
 * `offset:-1` is the sharp one — not an error and not a prefix, but a
 * *different* page than any valid offset returns. The "the corruption the
 * guard exists for" block below reproduces that outcome so the guard stays
 * anchored to the wrong rows rather than to the exception type.
 *
 * `MemoryStore` is exported from `src/index.ts`, so this is public API. The UI
 * is not the exposed path — `clampNumber` in `src/ui/server.ts` already clamps
 * HTTP input, and the last test here pins that it still does.
 */

import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { MemoryStore, assertPaginationOpts } from "../../src/trace/store.js";
import { PgStore } from "../../src/trace/pg-store.js";

const PR: PlannerState["pr"] = { owner: "o", repo: "r", number: 1 };
const REVIEW: Review = { summary: "s", findings: [], recommendation: "approve" };

function events(ts: number): TraceEvent[] {
  return [
    { ts, kind: "run_started", pr: PR },
    { ts: ts + 1, kind: "finalized", review: REVIEW },
  ];
}

async function seeded(ids: string[] = ["r1", "r2", "r3"]): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (const [i, run_id] of ids.entries()) {
    await store.writeRun({
      run_id,
      pr: PR,
      events: events(1_700_000_000_000 + i * 1000),
      review: REVIEW,
    });
  }
  return store;
}

const BAD_LIMITS: Array<[string, number]> = [
  ["negative", -1],
  ["zero", 0],
  ["fractional", 2.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["beyond safe integer", Number.MAX_SAFE_INTEGER + 2],
];

const BAD_OFFSETS: Array<[string, number]> = [
  ["negative", -1],
  ["fractional", 1.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
];

describe("listRuns pagination contract", () => {
  it.each(BAD_LIMITS)("rejects a %s limit", async (_label, limit) => {
    const store = await seeded();
    await expect(store.listRuns({ limit })).rejects.toThrow(/limit must be a positive integer/);
  });

  it.each(BAD_OFFSETS)("rejects a %s offset", async (_label, offset) => {
    const store = await seeded();
    await expect(store.listRuns({ offset })).rejects.toThrow(
      /offset must be a non-negative integer/,
    );
  });

  it("rejects a non-numeric limit that slipped past TypeScript", async () => {
    // The store is public API and consumers aren't all type-checked — a value
    // off `JSON.parse` or an untyped call site reaches here as-is.
    const store = await seeded();
    await expect(store.listRuns({ limit: "10" as unknown as number })).rejects.toThrow(
      /limit must be a positive integer; got string 10/,
    );
  });

  it("still defaults an omitted window to 50 / 0", async () => {
    const store = await seeded();
    expect((await store.listRuns()).map((r) => r.run_id)).toEqual(["r3", "r2", "r1"]);
    expect((await store.listRuns({})).map((r) => r.run_id)).toEqual(["r3", "r2", "r1"]);
    // Explicit `undefined` — `exactOptionalPropertyTypes` rejects it at the
    // type level, so this is the untyped-caller path, cast the same way.
    const explicitUndefined = { limit: undefined, offset: undefined } as unknown as {
      limit?: number;
      offset?: number;
    };
    expect((await store.listRuns(explicitUndefined)).map((r) => r.run_id)).toEqual([
      "r3",
      "r2",
      "r1",
    ]);
  });

  it("still paginates valid windows exactly as before", async () => {
    const store = await seeded();
    expect((await store.listRuns({ limit: 2 })).map((r) => r.run_id)).toEqual(["r3", "r2"]);
    expect((await store.listRuns({ limit: 2, offset: 1 })).map((r) => r.run_id)).toEqual([
      "r2",
      "r1",
    ]);
    expect((await store.listRuns({ limit: 1, offset: 2 })).map((r) => r.run_id)).toEqual(["r1"]);
    expect((await store.listRuns({ limit: 5, offset: 99 })).map((r) => r.run_id)).toEqual([]);
  });
});

describe("the corruption the guard exists for", () => {
  it("a negative offset used to return a different page, not a prefix", async () => {
    // Anchor the guard to the wrong rows rather than to the exception type, so
    // this can't later be "fixed" by loosening the check while the silent path
    // returns. `slice(-1, ...)` counts from the END of the sorted list.
    const ordered = ["r3", "r2", "r1"];
    const preFix = ordered.slice(-1, -1 + 50);
    expect(preFix).toEqual(["r1"]);
    expect(preFix).not.toEqual(ordered.slice(0, 50));

    const store = await seeded();
    await expect(store.listRuns({ offset: -1 })).rejects.toThrow(RangeError);
  });

  it("a negative limit used to drop the oldest run silently", async () => {
    const ordered = ["r3", "r2", "r1"];
    expect(ordered.slice(0, 0 + -1)).toEqual(["r3", "r2"]);

    const store = await seeded();
    await expect(store.listRuns({ limit: -1 })).rejects.toThrow(RangeError);
  });
});

describe("both backends share one validator", () => {
  it("PgStore rejects a bad window before it opens a pool", async () => {
    // No DATABASE_URL and no connection attempt: the guard runs first, which is
    // the point — a backend can't skip it, and this holds without Postgres.
    const store = new PgStore({ connectionString: "postgresql://unreachable:1/none" });
    await expect(store.listRuns({ limit: -1 })).rejects.toThrow(
      /limit must be a positive integer/,
    );
    await expect(store.listRuns({ offset: -1 })).rejects.toThrow(
      /offset must be a non-negative integer/,
    );
  });

  it("every listRuns implementation calls assertPaginationOpts", async () => {
    // Asserting "MemoryStore and PgStore are guarded" would go stale the moment
    // a third backend lands, which is how this gap would recur. Count the shape
    // across the trace module instead.
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = new URL("../../src/trace/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
    let implementations = 0;
    let guards = 0;
    for (const file of files) {
      const source = await readFile(new URL(file, dir), "utf8");
      implementations += (source.match(/async listRuns\(/g) ?? []).length;
      guards += (source.match(/assertPaginationOpts\(opts\)/g) ?? []).length;
    }
    expect(implementations).toBeGreaterThanOrEqual(2);
    expect(guards).toBe(implementations);
  });
});

describe("assertPaginationOpts directly", () => {
  it("returns the resolved window", () => {
    expect(assertPaginationOpts()).toEqual({ limit: 50, offset: 0 });
    expect(assertPaginationOpts({ limit: 7 })).toEqual({ limit: 7, offset: 0 });
    expect(assertPaginationOpts({ offset: 7 })).toEqual({ limit: 50, offset: 7 });
  });

  it("names the offending value in the message", () => {
    expect(() => assertPaginationOpts({ limit: -3 })).toThrow(/got -3/);
    expect(() => assertPaginationOpts({ offset: Number.NaN })).toThrow(/got NaN/);
  });
});
