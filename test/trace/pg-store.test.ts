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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { searchRepoTool } from "../../src/tools/search-repo.js";
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

// Every run id handed out, so `afterAll` can delete what this file wrote
// (#171). They used to stay: each `npm test` with DATABASE_URL set left 7 runs
// in whatever database it names -- a developer's real trace DB included, where
// they show up in the viewer.
const written: string[] = [];

async function uniqueRunId(): Promise<string> {
  // Tests can run in parallel; namespace by random + ts so they don't
  // collide on the (run_id) PK.
  const id = `pg-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  written.push(id);
  return id;
}

afterAll(async () => {
  if (!DATABASE_URL || written.length === 0) return;
  // Imported the way src/trace/pg-store.ts imports it, so the test does not
  // pull `@types/pg` into the type graph either.
  const mod = (await import("pg" as unknown as string)) as {
    Pool: new (cfg: { connectionString: string }) => {
      query(text: string, params?: unknown[]): Promise<unknown>;
      end(): Promise<void>;
    };
  };
  const pool = new mod.Pool({ connectionString: DATABASE_URL });
  try {
    // trace_events rows go with them: ON DELETE CASCADE (infra/postgres/init.sql).
    await pool.query("DELETE FROM runs WHERE run_id = ANY($1)", [written]);
  } finally {
    await pool.end();
  }
});

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

  it_pg("keeps a run whose search_repo hint was cut beside an emoji (#215)", async () => {
    // The hint cap sliced UTF-16 code units, so an astral character straddling
    // the cut left its high half in the observation, `jsonb` refused it, and the
    // whole run was lost here while MemoryStore kept it.
    const dir = await mkdtemp(path.join(tmpdir(), "aop-215-"));
    const line = `+${"x".repeat(235)}${String.fromCodePoint(0x1f600)}needle${"z".repeat(20)}`;
    await writeFile(
      path.join(dir, "pr.json"),
      JSON.stringify({ repo: "o/r", files: [{ filename: "a.txt", patch: `@@ -0,0 +1 @@\n${line}` }] }),
    );
    const step = { rationale: "r", tool: "search_repo", input: { owner: "o", repo: "r", query: "needle" } };
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    const runId = await uniqueRunId();
    try {
      const value = await searchRepoTool.run(
        { owner: "o", repo: "r", query: "needle", maxResults: 20 },
        { mode: "replay", fixturesDir: dir },
      );
      const events: TraceEvent[] = [
        { ts: 1_700_000_000_000, kind: "run_started", pr: PR },
        { ts: 1_700_000_000_001, kind: "observation", observation: { step, outcome: { kind: "ok", value } } },
        { ts: 1_700_000_000_002, kind: "finalized", review: review() },
      ];
      await store.writeRun({ run_id: runId, pr: PR, events, review: review() });
      const detail = await store.getRun(runId);
      expect(detail).not.toBeNull();
      expect(detail?.events[1]).toEqual(events[1]);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it_pg("a re-write under the same run_id replaces the whole row, pr included", async () => {
    // #129: the upsert listed 12 columns in the INSERT and 8 in the
    // DO UPDATE SET, so pr_owner / pr_repo / pr_number kept their old values
    // while everything else updated -- and the same transaction re-inserted the
    // event log carrying the NEW pr, so getRun returned one object naming two
    // different pull requests. MemoryStore replaces the whole run (Map.set), so
    // this is the parity assertion the hermetic half cannot make.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    const runId = await uniqueRunId();
    const OTHER: PlannerState["pr"] = { owner: "acme", repo: "beta", number: 99 };
    try {
      const first = makeEvents();
      await store.writeRun({ run_id: runId, pr: PR, events: first, review: review() });
      expect((await store.getRun(runId))?.pr).toEqual(PR);

      const second = makeEvents();
      second[0] = { ts: 1_700_000_000_000, kind: "run_started", pr: OTHER };
      await store.writeRun({ run_id: runId, pr: OTHER, events: second, review: review() });

      const detail = await store.getRun(runId);
      expect(detail?.pr).toEqual(OTHER);

      // And the row agrees with its own event log -- the inconsistency is what
      // made the stale columns worse than merely stale.
      const started = detail?.events.find((e) => e.kind === "run_started");
      expect(started).toBeTruthy();
      expect((started as Extract<TraceEvent, { kind: "run_started" }>).pr).toEqual(detail?.pr);
    } finally {
      await store.close();
    }
  });

  it_pg("listRuns orders newest-first across multiple writes", async () => {
    // it_pg only runs when DATABASE_URL is set, so the cast is safe.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    const ids: string[] = [];
    const started = Date.now();
    try {
      for (let i = 0; i < 3; i += 1) {
        const id = await uniqueRunId();
        ids.push(id);
        const evs = makeEvents();
        // Bump the run_started ts so the started_at ordering is stable
        // across the three rows we just wrote -- from now, not from a fixed
        // 2023 instant: `listRuns` returns the newest 10, and any run already
        // in the database (an earlier test run's, or a real one) was newer
        // than 2023, so these three fell out of the window (#171).
        evs[0] = { ts: started + i * 60_000, kind: "run_started", pr: PR };
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

  it_pg("replay with a new run_started ts updates started_at (parity with MemoryStore)", async () => {
    // #53: the ON CONFLICT UPDATE clause omitted `started_at = EXCLUDED.started_at`,
    // so a replay carrying a different run_started ts left the persisted started_at
    // stale — diverging from MemoryStore (which recomputes it on every write) and
    // drifting the `listRuns ORDER BY started_at DESC` ordering. it_pg only runs
    // when DATABASE_URL is set, so the cast is safe.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    const runId = await uniqueRunId();
    try {
      const t1 = 1_700_000_000_000;
      const t2 = 1_700_000_600_000; // +10 min
      const first = makeEvents();
      first[0] = { ts: t1, kind: "run_started", pr: PR };
      await store.writeRun({ run_id: runId, pr: PR, events: first, review: review() });

      const before = await store.getRun(runId);
      expect(before?.started_at).toBe(new Date(t1).toISOString());

      // Replay the same run_id with a later run_started ts.
      const second = makeEvents();
      second[0] = { ts: t2, kind: "run_started", pr: PR };
      await store.writeRun({ run_id: runId, pr: PR, events: second, review: review() });

      const after = await store.getRun(runId);
      expect(after?.started_at).toBe(new Date(t2).toISOString());
    } finally {
      await store.close();
    }
  });

  it_pg("a dollars total at the NUMERIC(12, 6) bound is stored, not a 22003 (#205)", async () => {
    // Two individually storable charges summing past 10^6, and one that quantises
    // UP to exactly 10^6: before #205 each lost the whole run to `numeric field
    // overflow` here while MemoryStore stored it.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    try {
      for (const charges of [[600_000, 600_000], [999_999.9999996]]) {
        const runId = await uniqueRunId();
        const events: TraceEvent[] = [
          { ts: 1_700_000_000_000, kind: "run_started", pr: PR },
          ...charges.map(
            (dollars, i) =>
              ({
                ts: 1_700_000_000_001 + i,
                kind: "observation",
                observation: {
                  step: { rationale: "r", tool: "ping", input: {} },
                  outcome: { kind: "ok", value: null },
                  cost: { dollars },
                },
              }) as TraceEvent,
          ),
          { ts: 1_700_000_000_009, kind: "finalized", review: review() },
        ];
        await store.writeRun({ run_id: runId, pr: PR, events, review: review() });
        const got = await store.getRun(runId);
        expect(got?.total_cost.dollars).toBeLessThan(1_000_000);
      }
    } finally {
      await store.close();
    }
  });

  it_pg("two run_ids differing only in a lone surrogate do not share a row (#209)", async () => {
    // `pg` sends a parameter as UTF-8, which turns a lone surrogate into U+FFFD,
    // so before #209 these two ids were ONE row: the second writeRun replaced
    // the first run, and getRun(first) answered with the second one's pr.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    const base = await uniqueRunId();
    const hi = base + String.fromCharCode(0xd800);
    const lo = base + String.fromCharCode(0xdc00);
    written.push(hi, lo); // cleanup reaches the U+FFFD row the same way
    const OTHER: PlannerState["pr"] = { owner: "acme", repo: "beta", number: 99 };
    const withPr = (pr: PlannerState["pr"]): TraceEvent[] => {
      const evs = makeEvents();
      evs[0] = { ts: 1_700_000_000_000, kind: "run_started", pr };
      return evs;
    };
    try {
      await store.writeRun({ run_id: hi, pr: PR, events: withPr(PR), review: review() }).catch(() => {});
      await store.writeRun({ run_id: lo, pr: OTHER, events: withPr(OTHER), review: review() }).catch(() => {});
      const replacement = String.fromCharCode(0xfffd);
      const merged = await store.getRun(base + replacement);
      expect(merged?.pr ?? null, "a run stored under the U+FFFD form of either id").toBeNull();
      expect(await store.getRun(hi)).toBeNull();
    } finally {
      await store.close();
    }
  });

  it_pg("getRun with a NUL in the id is null, not a 22021 (#209)", async () => {
    // The trace server hands `GET /api/runs/abc%00def` straight to getRun.
    const store = new PgStore({ connectionString: DATABASE_URL as string });
    try {
      expect(await store.getRun("abc" + String.fromCharCode(0) + "def")).toBeNull();
    } finally {
      await store.close();
    }
  });

  it_pg("getRun never returns one write's summary over another write's events (#238)", async () => {
    // getRun read runs and trace_events in two autocommit statements, each its
    // own READ COMMITTED snapshot. With a writer alternating two pull requests
    // under one run_id (each write one transaction, #177), 883 of 22453 reads
    // on Postgres 17 came back as "review of #1" over PR #2's event log.
    const writer = new PgStore({ connectionString: DATABASE_URL as string });
    const reader = new PgStore({ connectionString: DATABASE_URL as string });
    const runId = await uniqueRunId();
    const input = (n: number) => {
      const pr = { owner: "o", repo: "r", number: n };
      const events: TraceEvent[] = [{ ts: 1_700_000_000_000 + n, kind: "run_started", pr }];
      for (let i = 0; i < 20; i += 1) {
        events.push({ ts: 1_700_000_000_100, kind: "plan_emitted", plan: { goal: `g${n}`, steps: [] }, version: i });
      }
      return { run_id: runId, pr, events, review: review({ summary: `review of #${n}` }) };
    };
    try {
      await writer.writeRun(input(1));
      let stop = false;
      let writes = 0;
      const w = (async () => {
        let n = 1;
        while (!stop) {
          n = n === 1 ? 2 : 1;
          await writer.writeRun(input(n));
          writes += 1;
        }
      })();
      const torn: string[] = [];
      try {
        for (let i = 0; i < 1500; i += 1) {
          const got = await reader.getRun(runId);
          const evPr = (got?.events[0] as Extract<TraceEvent, { kind: "run_started" }>).pr.number;
          if (got?.pr.number !== evPr || got?.summary !== `review of #${evPr}`) {
            torn.push(`summary pr=#${got?.pr.number} over events of #${evPr}`);
          }
        }
      } finally {
        stop = true;
        await w;
      }
      // Anti-vacuity: the reads must actually have raced rewrites.
      expect(writes).toBeGreaterThan(10);
      expect(torn.slice(0, 3)).toEqual([]);
    } finally {
      await writer.close();
      await reader.close();
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
