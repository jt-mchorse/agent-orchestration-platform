/**
 * PgStore integration tests.
 *
 * Skipped entirely unless `DATABASE_URL` is set, so the default test run
 * stays hermetic. CI's `pg-integration` job sets `DATABASE_URL` and
 * brings up the Postgres service container with `init.sql` mounted.
 *
 * Locally:
 *   docker compose up -d
 *   DATABASE_URL=postgresql://agent:agent@localhost:5433/agent_trace npm test
 */

import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { PgStore } from "../../src/trace/pg-store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const it_pg = DATABASE_URL ? it : it.skip;

const PR: PlannerState["pr"] = { owner: "jt-mchorse", repo: "test", number: 42 };

function review(overrides: Partial<Review> = {}): Review {
  return {
    summary: "pg integration summary",
    findings: [],
    recommendation: "approve",
    ...overrides,
  };
}

function makeEvents(): TraceEvent[] {
  return [
    { ts: 1_700_000_000_000, kind: "run_started", pr: PR },
    {
      ts: 1_700_000_000_001,
      kind: "plan_emitted",
      plan: { goal: "test", steps: [{ rationale: "r", tool: "ping", input: { msg: "hi" } }] },
      version: 0,
    },
    {
      ts: 1_700_000_000_002,
      kind: "step_started",
      step: { rationale: "r", tool: "ping", input: { msg: "hi" } },
      index: 0,
    },
    {
      ts: 1_700_000_000_003,
      kind: "observation",
      observation: {
        step: { rationale: "r", tool: "ping", input: { msg: "hi" } },
        outcome: { kind: "ok", value: { pong: "hi" } },
        cost: { input_tokens: 25, output_tokens: 5, dollars: 0.0007 },
      },
    },
    { ts: 1_700_000_000_004, kind: "finalized", review: review() },
  ];
}

async function uniqueRunId(): Promise<string> {
  // Tests can run in parallel; namespace by random + ts so they don't
  // collide on the (run_id) PK.
  return `pg-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("PgStore (integration; DATABASE_URL required)", () => {
  it_pg("writes and reads a run round-trip", async () => {
    // it_pg only runs when DATABASE_URL is set, so the cast is safe.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    const runId = await uniqueRunId();
    try {
      await store.writeRun({
        run_id: runId,
        pr: PR,
        events: makeEvents(),
        review: review(),
      });
      const detail = await store.getRun(runId);
      expect(detail).not.toBeNull();
      expect(detail?.run_id).toBe(runId);
      expect(detail?.events).toHaveLength(5);
      expect(detail?.total_cost.dollars).toBeCloseTo(0.0007, 6);
      expect(detail?.total_cost.input_tokens).toBe(25);
      expect(detail?.total_cost.output_tokens).toBe(5);
      expect(detail?.status).toBe("finalized");
      expect(detail?.recommendation).toBe("approve");
    } finally {
      await store.close();
    }
  });

  it_pg("listRuns orders newest-first across multiple writes", async () => {
    // it_pg only runs when DATABASE_URL is set, so the cast is safe.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    const ids: string[] = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        const id = await uniqueRunId();
        ids.push(id);
        const evs = makeEvents();
        // Bump the run_started ts so the started_at ordering is stable
        // across the three rows we just wrote.
        evs[0] = { ts: 1_700_000_000_000 + i * 60_000, kind: "run_started", pr: PR };
        await store.writeRun({ run_id: id, pr: PR, events: evs, review: review() });
      }
      const list = await store.listRuns({ limit: 10 });
      // Pull out the three rows we just wrote in started_at-desc order.
      const ours = list.filter((r) => ids.includes(r.run_id)).map((r) => r.run_id);
      expect(ours).toEqual([...ids].reverse());
    } finally {
      await store.close();
    }
  });

  it_pg("is idempotent: re-writing the same run_id replaces its events", async () => {
    // it_pg only runs when DATABASE_URL is set, so the cast is safe.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    const runId = await uniqueRunId();
    try {
      // Initial write with 5 events.
      await store.writeRun({
        run_id: runId,
        pr: PR,
        events: makeEvents(),
        review: review(),
      });
      // Replay with fewer events (3) — verifies the DELETE-then-INSERT path.
      const truncated = makeEvents().slice(0, 3);
      await store.writeRun({
        run_id: runId,
        pr: PR,
        events: truncated,
        review: review({ summary: "replayed" }),
      });
      const detail = await store.getRun(runId);
      expect(detail?.events).toHaveLength(3);
      expect(detail?.summary).toBe("replayed");
    } finally {
      await store.close();
    }
  });

  it_pg("returns null for a missing run", async () => {
    // it_pg only runs when DATABASE_URL is set, so the cast is safe.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    try {
      expect(await store.getRun("definitely-does-not-exist-xyz")).toBeNull();
    } finally {
      await store.close();
    }
  });
});
