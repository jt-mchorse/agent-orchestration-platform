/**
 * Both `TraceStore` backends derive a run's start, end and status from the
 * SAME definition (#139).
 *
 * Five rules are needed by both `MemoryStore` and `PgStore`. Two were shared
 * and three were duplicated:
 *
 *     rule                     shared?
 *     aggregateCost            yes — imported by pg-store.ts
 *     assertPaginationOpts     yes — and #117's comment says why: "from the
 *                                    same validator, so the two backends of
 *                                    this interface can't disagree"
 *     deriveStatus             NO  — pg-store.ts had its own copy
 *     started-at derivation    NO  — `startedAtIso`
 *     finalized-at derivation  NO  — `finalizedAtIso`
 *
 * The copies agreed on every input, so nothing was broken — the point is that
 * nothing enforced the agreement, and #129 had already shown what happens when
 * the two backends disagree about what `writeRun` means.
 *
 * Two assertions, and both are needed:
 *
 * - The **behavioural** one drives one table of event logs through both
 *   backends and compares the results. It is what catches a divergence today.
 * - The **structural** one forbids `pg-store.ts` from declaring any derivation
 *   over an event log at all. It is what catches the next re-copy — which the
 *   behavioural test cannot, because two identical copies agree by
 *   construction. That is the same reason `upsert-column-parity.test.ts` exists
 *   as a structural check over the SQL rather than a round-trip assertion.
 *
 * No Postgres: `PgStore`'s side is captured from the fake pool
 * `upsert-column-parity.test.ts` established, so this runs in the default
 * hermetic suite rather than only in the `DATABASE_URL`-gated job.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { PgStore } from "../../src/trace/pg-store.js";
import { MemoryStore, type RunSummary } from "../../src/trace/store.js";

const PR: PlannerState["pr"] = { owner: "jt-mchorse", repo: "alpha", number: 1 };
const REVIEW: Review = { summary: "s", findings: [], recommendation: "approve" };

const T0 = 1_700_000_000_000;

const started = (ts = T0): TraceEvent => ({ ts, kind: "run_started", pr: PR });
const finalized = (ts: number): TraceEvent => ({ ts, kind: "finalized", review: REVIEW });
const aborted = (ts: number): TraceEvent => ({
  ts,
  kind: "aborted",
  reason: "budget exhausted",
});

/**
 * Event logs chosen so the three derived columns actually MOVE across rows.
 * A table where every row yielded the same status would let the comparison
 * below hold while proving nothing about the rules.
 */
const LOGS: ReadonlyArray<readonly [string, TraceEvent[]]> = [
  ["in flight — no terminal event", [started()]],
  ["finalized cleanly", [started(), finalized(T0 + 5)]],
  ["aborted", [started(), aborted(T0 + 5)]],
  [
    "aborted AFTER a finalize — aborted wins regardless of order",
    [started(), finalized(T0 + 5), aborted(T0 + 9)],
  ],
  [
    "two terminal events — the LAST one dates the run",
    [started(), finalized(T0 + 5), finalized(T0 + 40)],
  ],
  ["terminal event only — no run_started to date it from", [finalized(T0 + 5)]],
  ["empty log", []],
];

interface Captured {
  sql: string;
  params: unknown[];
}

/** Drive the real `PgStore.writeRun` and capture the row it would INSERT. */
async function pgInsertParams(events: TraceEvent[]): Promise<unknown[]> {
  const captured: Captured[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
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
  return (insert as Captured).params;
}

/**
 * The INSERT's parameter positions for the three derived columns, read from the
 * statement's own column list rather than hard-coded — a hand-written index
 * would silently point at the wrong column the day a column is inserted before
 * them, and then this whole file would compare the wrong two values.
 */
async function pgDerived(events: TraceEvent[]): Promise<{
  started_at: unknown;
  finalized_at: unknown;
  status: unknown;
}> {
  const captured: Captured[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      captured.push({ sql, params });
      return { rows: [] };
    },
    async end() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new PgStore({ pool: pool as any });
  await store.writeRun({ run_id: "r1", pr: PR, review: REVIEW, events });
  const insert = captured.find((c) => c.sql.includes("INSERT INTO runs")) as Captured;
  const match = insert.sql.match(/INSERT INTO runs \(([\s\S]*?)\)\s*\n?\s*VALUES/);
  expect(match, "could not parse the INSERT column list").toBeTruthy();
  const columns = ((match as RegExpMatchArray)[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const at = (name: string): unknown => {
    const i = columns.indexOf(name);
    expect(i, `column ${name} is not in the INSERT`).toBeGreaterThanOrEqual(0);
    return insert.params[i];
  };
  return {
    started_at: at("started_at"),
    finalized_at: at("finalized_at"),
    status: at("status"),
  };
}

async function memoryDerived(events: TraceEvent[]): Promise<RunSummary> {
  const store = new MemoryStore();
  await store.writeRun({ run_id: "r1", pr: PR, review: REVIEW, events });
  const detail = await store.getRun("r1");
  expect(detail).not.toBeNull();
  return detail as RunSummary;
}

describe("TraceStore derivation parity (#139)", () => {
  describe.each(LOGS)("%s", (_label, events) => {
    it("both backends derive the same status", async () => {
      const [mem, pg] = await Promise.all([memoryDerived(events), pgDerived(events)]);
      expect(pg.status).toBe(mem.status);
    });

    it("both backends derive the same finalized_at", async () => {
      const [mem, pg] = await Promise.all([memoryDerived(events), pgDerived(events)]);
      expect(pg.finalized_at).toBe(mem.finalized_at);
    });

    it("both backends derive the same started_at, when the log dates it", async () => {
      // A log with no `run_started` falls back to "now" on BOTH sides, and two
      // `new Date()` calls milliseconds apart are legitimately different. That
      // row is covered by the status and finalized_at assertions above, and by
      // the shape assertion here, rather than by an equality that would be
      // flaky for a reason unrelated to the rule.
      const [mem, pg] = await Promise.all([memoryDerived(events), pgDerived(events)]);
      if (events.some((e) => e.kind === "run_started")) {
        expect(pg.started_at).toBe(mem.started_at);
      } else {
        expect(typeof pg.started_at).toBe("string");
        expect(Number.isNaN(Date.parse(pg.started_at as string))).toBe(false);
        expect(Number.isNaN(Date.parse(mem.started_at))).toBe(false);
      }
    });
  });

  it("the table moves all three derived columns", async () => {
    // Anti-vacuous. If every row produced the same status and the same
    // finalized_at, the equalities above would hold for a pair of rules that
    // both ignored their input entirely.
    const rows = await Promise.all(LOGS.map(([, events]) => memoryDerived(events)));
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set(["running", "finalized", "aborted"]),
    );
    expect(new Set(rows.map((r) => r.finalized_at === null)).size).toBe(2);
    expect(new Set(rows.map((r) => r.finalized_at)).size).toBeGreaterThanOrEqual(3);
  });

  it("aborted wins over finalized regardless of event order", async () => {
    // Named separately because it is the one rule whose answer is not the
    // last terminal event, and the row above only proves the two backends
    // agree — not that they agree on the RIGHT answer.
    const mem = await memoryDerived([started(), finalized(T0 + 5), aborted(T0 + 9)]);
    expect(mem.status).toBe("aborted");
    const mem2 = await memoryDerived([started(), aborted(T0 + 5), finalized(T0 + 9)]);
    expect(mem2.status).toBe("aborted");
  });

  it("the INSERT still carries every derived column it did before", async () => {
    // Guards the harness above: if `started_at` were dropped from the
    // statement, `at()` would fail loudly rather than this file quietly
    // comparing two undefineds.
    const params = await pgInsertParams([started(), finalized(T0 + 5)]);
    expect(params.length).toBeGreaterThanOrEqual(12);
  });
});

describe("no backend re-declares a derivation over an event log", () => {
  const PG_STORE = resolve(__dirname, "..", "..", "src", "trace", "pg-store.ts");
  const STORE = resolve(__dirname, "..", "..", "src", "trace", "store.ts");

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  /** Every top-level function in *src* whose sole parameter is an event log. */
  function eventLogFunctions(src: string): string[] {
    return [
      ...stripComments(src).matchAll(
        /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(\s*events\s*:\s*TraceEvent\[\]/gm,
      ),
    ]
      .map((m) => m[1])
      .filter((n): n is string => typeof n === "string")
      .sort();
  }

  it("store.ts owns them, and they are exported", () => {
    // Anti-vacuous, and the half that makes the negative rule below mean
    // something: a scan that found nothing anywhere would satisfy it while
    // checking nothing.
    //
    // `aggregateCost` is in this list because the *discovered* rule — a
    // top-level function whose parameter is an event log — is what a
    // derivation actually is, and it is one. I had hand-listed the three from
    // the issue and the scan found a fourth that was already correct. Naming
    // it here is the honest population and it costs nothing; hand-listing only
    // the three would have been a rule that agreed with its author rather than
    // with the code.
    const owned = eventLogFunctions(readFileSync(STORE, "utf8"));
    expect(owned).toEqual([
      "aggregateCost",
      "deriveFinalizedAt",
      "deriveStartedAt",
      "deriveStatus",
    ]);
    const src = stripComments(readFileSync(STORE, "utf8"));
    for (const name of owned) {
      expect(src).toMatch(new RegExp(`export function ${name}\\b`));
    }
  });

  it("pg-store.ts declares none of its own", () => {
    // The lock. `deriveStatus`, `startedAtIso` and `finalizedAtIso` lived here
    // as byte-equivalent copies; a fourth rule pasted in again fails here
    // rather than agreeing with its twin until the day it doesn't.
    expect(eventLogFunctions(readFileSync(PG_STORE, "utf8"))).toEqual([]);
  });

  it("pg-store.ts imports the shared ones instead", () => {
    // Stating what must be PRESENT, not only what must be absent: a file
    // satisfies the rule above by doing nothing at all, which is how a partial
    // adoption passes.
    const src = stripComments(readFileSync(PG_STORE, "utf8"));
    for (const name of ["deriveStatus", "deriveStartedAt", "deriveFinalizedAt"]) {
      expect(src).toContain(name);
    }
  });
});
