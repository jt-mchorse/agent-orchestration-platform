/**
 * The `ts` domain the three derivations #140 shared, guarded (#141).
 *
 * #140 promoted `deriveStatus`, `deriveStartedAt` and `deriveFinalizedAt` from
 * per-backend copies to one shared definition, on the argument that the two
 * `TraceStore` backends must not "disagree about what `writeRun` means". It
 * achieved that. What it shared was an *unguarded input domain*.
 *
 * `TraceEvent.ts` is a `number` produced by a public, pluggable `Clock`, and
 * nothing validated what a clock returns before `new Date(ts).toISOString()`
 * saw it. Measured on the parent commit, hermetically:
 *
 *     clock                        emitted        MemoryStore round-trip  deriveStartedAt
 *     integral (Date.now)          1700000000000  1700000000000           2023-11-14T22:13:20.000Z
 *     fractional (performance.now) 1234.5678      1234.5678               1970-01-01T00:00:01.234Z
 *     NaN                          NaN            THREW RangeError        THREW RangeError
 *     Infinity                     Infinity       THREW RangeError        THREW RangeError
 *     negative                     -1             -1                      1969-12-31T23:59:59.999Z
 *
 * The non-finite rows threw `RangeError: Invalid time value` — naming no
 * function, no field and no value — and escaped `writeRun` on BOTH backends:
 * the parity #140 delivered, on a crash.
 *
 * The fractional row is the silent one. `1234.5678` survives `MemoryStore`'s
 * round trip exactly while the derived summary reads `...01.234Z`, so the
 * stored event and the summary disagree about when the run started. And
 * `infra/postgres/init.sql` declares `ts BIGINT NOT NULL`, which cannot hold
 * it at all — a failure visible only in the `DATABASE_URL`-gated job, the
 * exact property #140 called out as what made `deriveStatus` "the costliest of
 * the three to get wrong".
 *
 * `performance.now()` is the natural way to get there: the default clock's
 * comment used to call `Date.now()` "monotonic ms-since-epoch". It is not
 * monotonic, and a developer who took that requirement seriously would reach
 * for the function that is. That comment is corrected in the same change.
 */
import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { PgStore } from "../../src/trace/pg-store.js";
import {
  MemoryStore,
  deriveFinalizedAt,
  deriveStartedAt,
  deriveStatus,
} from "../../src/trace/store.js";

const PR: PlannerState["pr"] = { owner: "o", repo: "r", number: 1 };
const REVIEW: Review = { recommendation: "approve", summary: "s", findings: [] };

function eventsAt(ts: number): TraceEvent[] {
  return [
    { ts, kind: "run_started", pr: PR },
    { ts, kind: "finalized", review: REVIEW },
  ] as TraceEvent[];
}

/** Drive the real `PgStore.writeRun` against a fake pool — no Postgres. */
async function pgWriteRun(events: TraceEvent[]): Promise<void> {
  const pool = {
    async query() {
      return { rows: [] };
    },
    async end() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new PgStore({ pool: pool as any });
  await store.writeRun({ run_id: "r1", pr: PR, review: REVIEW, events });
}

async function memWriteRun(events: TraceEvent[]): Promise<void> {
  await new MemoryStore().writeRun({ run_id: "r1", pr: PR, review: REVIEW, events });
}

// Refused. Each is a value a `Clock` can return and the `ts BIGINT` column
// cannot hold, or that `toISOString()` cannot render faithfully.
const REJECTED: [string, number][] = [
  ["fractional — what performance.now() returns", 1234.5678],
  ["a whole-number float is fine, but 0.5 is not", 1700000000000.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  // Beyond 2^53-1 an integer is no longer exactly representable, so it is not
  // the value the BIGINT column would receive.
  ["unsafe integer (2^53)", 2 ** 53],
  // A safe integer that `Date` still cannot represent -- MAX_SAFE_INTEGER is
  // 9.007e15 and Date's range is +/-8.64e15. This row is why the guard is an
  // intersection of two constraints: my first spelling used
  // `Number.isSafeInteger` alone and let this through.
  ["the largest safe integer, outside Date's range", Number.MAX_SAFE_INTEGER],
  ["one ms past Date's maximum", 8_640_000_000_000_001],
];

// Accepted. Negative is load-bearing: a pre-epoch instant is a real instant
// and BIGINT holds it, so refusing it would be new strictness rather than
// parity with the column.
const ACCEPTED: [string, number][] = [
  ["a realistic Date.now()", 1700000000000],
  ["zero — the epoch itself", 0],
  ["negative — a pre-epoch instant", -1],
  ["a large pre-epoch instant", -2208988800000],
  // Date's own maximum. This is the real upper boundary, and it is NARROWER
  // than the safe integers.
  ["Date's maximum representable instant", 8_640_000_000_000_000],
  ["Date's minimum representable instant", -8_640_000_000_000_000],
];

describe("deriveStartedAt / deriveFinalizedAt refuse a ts they cannot render", () => {
  it.each(REJECTED)("%s — deriveStartedAt", (_label, ts) => {
    expect(() => deriveStartedAt(eventsAt(ts))).toThrow(RangeError);
    // The message, not just the type. `new Date(NaN).toISOString()` ALREADY
    // threw a RangeError — the whole point is that it named nothing. Asserting
    // only the type would have passed against the unfixed code.
    expect(() => deriveStartedAt(eventsAt(ts))).toThrow(/deriveStartedAt: event\.ts/);
    expect(() => deriveStartedAt(eventsAt(ts))).toThrow(/run_started/);
  });

  it.each(REJECTED)("%s — deriveFinalizedAt", (_label, ts) => {
    expect(() => deriveFinalizedAt(eventsAt(ts))).toThrow(/deriveFinalizedAt: event\.ts/);
    // It names the event whose ts is bad, which for this rule is the LAST
    // terminal event rather than the first.
    expect(() => deriveFinalizedAt(eventsAt(ts))).toThrow(/finalized/);
  });

  it.each(REJECTED)("%s — the message quotes the offending value", (_label, ts) => {
    try {
      deriveStartedAt(eventsAt(ts));
      expect.unreachable("expected a RangeError");
    } catch (e) {
      expect((e as Error).message).toContain(String(ts));
      // And it points at the cause a caller can act on.
      expect((e as Error).message).toMatch(/clock/);
    }
  });
});

describe("a valid ts still works, including the boundaries", () => {
  it.each(ACCEPTED)("%s", (_label, ts) => {
    expect(deriveStartedAt(eventsAt(ts))).toBe(new Date(ts).toISOString());
    expect(deriveFinalizedAt(eventsAt(ts))).toBe(new Date(ts).toISOString());
  });

  it("an empty event list still falls back to now rather than throwing", () => {
    // The pre-existing defensive behaviour, unchanged: there is no event to
    // read a ts from, so there is nothing for the guard to reject.
    expect(() => deriveStartedAt([])).not.toThrow();
    expect(deriveFinalizedAt([])).toBeNull();
  });
});

describe("both backends refuse identically — #140's own contract", () => {
  it.each(REJECTED)("%s — MemoryStore.writeRun", async (_label, ts) => {
    await expect(memWriteRun(eventsAt(ts))).rejects.toThrow(/event\.ts must be a safe integer/);
  });

  it.each(REJECTED)("%s — PgStore.writeRun", async (_label, ts) => {
    // Hermetic: the fake pool means this asserts PgStore's own behaviour, not
    // Postgres's. Without the guard, PgStore reached the RangeError from
    // `toISOString()` too — the same crash, so the two "agreed" by both being
    // broken. Now they agree by both naming the problem.
    await expect(pgWriteRun(eventsAt(ts))).rejects.toThrow(/event\.ts must be a safe integer/);
  });

  it.each(ACCEPTED)("%s — both backends accept", async (_label, ts) => {
    await expect(memWriteRun(eventsAt(ts))).resolves.toBeUndefined();
    await expect(pgWriteRun(eventsAt(ts))).resolves.toBeUndefined();
  });
});

describe("deriveStatus is deliberately unguarded", () => {
  it.each([...REJECTED, ...ACCEPTED])("%s — status is still derived", (_label, ts) => {
    // It reads only `kind`, so a bad `ts` cannot change its answer, and
    // guarding it would refuse a question it can answer correctly. The
    // asymmetry is asserted rather than left to be re-litigated.
    expect(deriveStatus(eventsAt(ts))).toBe("finalized");
  });
});

describe("the guard's rule matches the column and the renderer", () => {
  it("rejects exactly what BIGINT cannot hold or toISOString cannot render", () => {
    // The rule is `Number.isSafeInteger`. Stated as a property over the two
    // constraints it exists to satisfy, so a future edit that widens it has to
    // argue with both rather than with a predicate name.
    for (const [, ts] of ACCEPTED) {
      expect(Number.isSafeInteger(ts), `${ts} should be storable`).toBe(true);
      // Renders without truncation: the ISO string round-trips to the same ms.
      expect(new Date(ts).getTime()).toBe(ts);
    }
    for (const [, ts] of REJECTED) {
      const renderable = Number.isFinite(ts) && new Date(ts).getTime() === ts;
      expect(renderable && Number.isSafeInteger(ts), `${ts} should be refused`).toBe(false);
    }
  });

  it("the schema really does declare ts as BIGINT — the reason for the rule", async () => {
    // Anti-vacuous, and the tie to the constraint. If the column ever becomes
    // NUMERIC, `Number.isSafeInteger` is stricter than it needs to be and this
    // says so instead of leaving the rule unexplained.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const sql = readFileSync(
      resolve(import.meta.dirname, "../../infra/postgres/init.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ts\s+BIGINT NOT NULL/);
  });
});

describe("the corrected clock comment", () => {
  it("no longer calls Date.now() monotonic", async () => {
    // That claim is what pointed a reader at `performance.now()`, whose
    // fractional return value is the silent row above. Asserted on the source
    // because it is a comment, and a comment that misstates a guarantee is how
    // a caller chooses the wrong clock.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dirname, "../../src/agent/trace.js".replace(".js", ".ts")), "utf8");
    const clockComment = src.slice(src.indexOf("this.clock = opts.clock") - 700, src.indexOf("this.clock = opts.clock"));
    expect(clockComment).toMatch(/NOT monotonic/);
    expect(clockComment).not.toMatch(/Default: monotonic/);
  });
});
