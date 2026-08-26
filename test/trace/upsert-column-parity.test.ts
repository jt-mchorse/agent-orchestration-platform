/**
 * PgStore's upsert must replace the whole row, not a subset (#129).
 *
 * `writeRun`'s statement listed **12 columns in the INSERT and 8 in the
 * `DO UPDATE SET`**. `run_id` is correctly excluded as the conflict key; the
 * other three were simply missing:
 *
 *     INSERT columns (12): run_id, pr_owner, pr_repo, pr_number, started_at,
 *                          finalized_at, status, total_cost_dollars,
 *                          total_input_tokens, total_output_tokens,
 *                          recommendation, summary
 *     DO UPDATE SET  (8):  started_at, finalized_at, status, total_cost_dollars,
 *                          total_input_tokens, total_output_tokens,
 *                          recommendation, summary
 *     NOT updated on conflict: pr_owner, pr_repo, pr_number
 *
 * Postgres leaves an unlisted column at its existing value, so a re-write under
 * an existing `run_id` kept the old PR reference while updating everything else.
 * And the same transaction deletes and re-inserts `trace_events`, whose first
 * event is `run_started` carrying the *new* `pr` — so `getRun` returned one
 * object naming two different pull requests: `pr` from the stale `runs` row,
 * `events[0].pr` from the fresh log.
 *
 * `MemoryStore.writeRun` is `this.runs.set(run_id, detail)` — a whole-row
 * replace. So the two backends of `TraceStore` disagreed about what `writeRun`
 * means for an existing `run_id`, which is what `PgStore.listRuns`'s own comment
 * says must not happen: "so the two backends of this interface can't disagree".
 *
 * The structural assertion below is worth more than the three-column fix: it
 * fails for the *next* column added to the INSERT and forgotten in the UPDATE.
 * It needs no Postgres — the SQL is captured from a fake pool — so it runs in
 * the default hermetic suite rather than only in the `pg-integration` job.
 */

import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { PgStore } from "../../src/trace/pg-store.js";
import { MemoryStore } from "../../src/trace/store.js";

const PR_A: PlannerState["pr"] = { owner: "jt-mchorse", repo: "alpha", number: 1 };
const PR_B: PlannerState["pr"] = { owner: "acme", repo: "beta", number: 99 };

const REVIEW: Review = { summary: "s", findings: [], recommendation: "approve" };

function eventsFor(pr: PlannerState["pr"]): TraceEvent[] {
  return [
    { ts: 1_700_000_000_000, kind: "run_started", pr },
    { ts: 1_700_000_000_004, kind: "finalized", review: REVIEW },
  ];
}

interface Captured {
  sql: string;
  params: unknown[];
}

/** Drive the real `writeRun` and capture every statement it emits. */
async function captureWriteRunSql(pr: PlannerState["pr"] = PR_A): Promise<Captured[]> {
  const captured: Captured[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      captured.push({ sql, params });
      return { rows: [] };
    },
    async end() {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new PgStore({ pool: pool as any });
  await store.writeRun({ run_id: "r1", pr, review: REVIEW, events: eventsFor(pr) });
  return captured;
}

function insertStatement(captured: Captured[]): string {
  const stmt = captured.find((c) => c.sql.includes("INSERT INTO runs"));
  expect(stmt, "writeRun emitted no INSERT INTO runs").toBeTruthy();
  return (stmt as Captured).sql;
}

function insertColumns(sql: string): string[] {
  const match = sql.match(/INSERT INTO runs \(([\s\S]*?)\)\s*\n?\s*VALUES/);
  expect(match, "could not parse the INSERT column list").toBeTruthy();
  const group = (match as RegExpMatchArray)[1] ?? "";
  return group
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function updatedColumns(sql: string): string[] {
  return [...sql.matchAll(/^\s*([a-z_]+)\s*=\s*EXCLUDED\.[a-z_]+\s*,?\s*$/gm)]
    .map((m) => m[1])
    .filter((c): c is string => typeof c === "string");
}

describe("PgStore.writeRun upsert", () => {
  it("updates every non-key INSERT column on conflict", async () => {
    const sql = insertStatement(await captureWriteRunSql());
    const cols = insertColumns(sql);
    const updated = updatedColumns(sql);

    const missing = cols.filter((c) => c !== "run_id" && !updated.includes(c));
    expect(
      missing,
      `these columns are INSERTed but never updated on conflict, so a re-written ` +
        `run keeps their old values: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("does not update the conflict key itself", () => {
    // `run_id = EXCLUDED.run_id` is a no-op at best and noise at worst; the
    // assertion above must not push anyone into adding it.
    return captureWriteRunSql().then((captured) => {
      expect(updatedColumns(insertStatement(captured))).not.toContain("run_id");
    });
  });

  it("names the three columns that were missing, so the parser is looking at the right statement", async () => {
    const updated = updatedColumns(insertStatement(await captureWriteRunSql()));
    for (const col of ["pr_owner", "pr_repo", "pr_number"]) {
      expect(updated).toContain(col);
    }
  });

  it("parses a non-trivial column list, so the check cannot pass vacuously", async () => {
    const sql = insertStatement(await captureWriteRunSql());
    expect(insertColumns(sql).length).toBeGreaterThanOrEqual(10);
    expect(updatedColumns(sql).length).toBeGreaterThanOrEqual(10);
  });

  it("still passes the new pr values as INSERT parameters", async () => {
    const captured = await captureWriteRunSql(PR_B);
    const stmt = captured.find((c) => c.sql.includes("INSERT INTO runs")) as Captured;
    expect(stmt.params).toContain(PR_B.owner);
    expect(stmt.params).toContain(PR_B.repo);
    expect(stmt.params).toContain(PR_B.number);
  });

  it("re-inserts the event log carrying the new pr, which is what made the stale row inconsistent", async () => {
    const captured = await captureWriteRunSql(PR_B);
    expect(captured.some((c) => c.sql.includes("DELETE FROM trace_events"))).toBe(true);
    const eventInserts = captured.filter((c) => c.sql.includes("INSERT INTO trace_events"));
    expect(eventInserts.length).toBeGreaterThan(0);
    const runStarted = eventInserts.find((c) => String(c.params[3]) === "run_started");
    expect(runStarted, "no run_started event was written").toBeTruthy();
    expect(String((runStarted as Captured).params[4])).toContain(PR_B.owner);
  });
});

describe("TraceStore.writeRun whole-row replace", () => {
  it("MemoryStore replaces the pr on a re-write", async () => {
    const store = new MemoryStore();
    await store.writeRun({ run_id: "r1", pr: PR_A, review: REVIEW, events: eventsFor(PR_A) });
    expect((await store.getRun("r1"))?.pr).toEqual(PR_A);

    await store.writeRun({ run_id: "r1", pr: PR_B, review: REVIEW, events: eventsFor(PR_B) });
    const after = await store.getRun("r1");
    expect(after?.pr).toEqual(PR_B);
  });

  it("MemoryStore's summary and its own event log agree after a re-write", async () => {
    // The inconsistency PgStore had: the row said one PR, the events said
    // another. Pin that MemoryStore never does this, so the parity test in the
    // pg-integration job has a reference answer.
    const store = new MemoryStore();
    await store.writeRun({ run_id: "r1", pr: PR_A, review: REVIEW, events: eventsFor(PR_A) });
    await store.writeRun({ run_id: "r1", pr: PR_B, review: REVIEW, events: eventsFor(PR_B) });

    const detail = await store.getRun("r1");
    const started = detail?.events.find((e) => e.kind === "run_started");
    expect(started).toBeTruthy();
    expect((started as Extract<TraceEvent, { kind: "run_started" }>).pr).toEqual(detail?.pr);
  });
});
