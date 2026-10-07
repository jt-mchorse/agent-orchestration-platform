/**
 * One run's writes are one transaction on one connection (#177).
 *
 * `writeRun` sent BEGIN, its inserts and COMMIT/ROLLBACK through `pool.query`,
 * which takes whichever pooled connection is free for each statement. With
 * concurrent writers the transaction split across connections: on a
 * 1-connection pool a rejected run left {runs: 1, events: 10} behind, and in
 * another ordering a good run failed because the bad run's ROLLBACK undid it.
 */
import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { PgStore } from "../../src/trace/pg-store.js";

const PR: PlannerState["pr"] = { owner: "jt-mchorse", repo: "t", number: 1 };
const REVIEW: Review = { summary: "s", findings: [], recommendation: "approve" };

function events(n: number, poison = false): TraceEvent[] {
  const evs: TraceEvent[] = [{ ts: 1_700_000_000_000, kind: "run_started", pr: PR }];
  for (let i = 1; i < n; i += 1) {
    evs.push({
      ts: 1_700_000_000_000 + i,
      kind: "observation",
      observation: {
        step: { rationale: "r", tool: "ping", input: { msg: poison && i === n - 1 ? "\u0000" : "hi" } },
        outcome: { kind: "ok", value: {} },
        cost: { input_tokens: 1, output_tokens: 1, dollars: 0 },
      },
    } as TraceEvent);
  }
  return evs;
}

describe("writeRun's transaction (#177)", () => {
  function recordingPool(failOn?: RegExp) {
    const viaClient: string[] = [];
    let released = 0;
    const pool = {
      async query(sql: string) {
        throw new Error(`writeRun sent "${sql.trim().slice(0, 30)}" through pool.query`);
      },
      async connect() {
        return {
          async query(sql: string) {
            viaClient.push(sql.trim().split(/\s+/)[0]!.toUpperCase());
            if (failOn && failOn.test(sql) && !/^ROLLBACK/.test(sql)) throw new Error("insert rejected");
            return { rows: [] };
          },
          release() {
            released += 1;
          },
        };
      },
      async end() {},
    };
    return { pool, viaClient, released: () => released };
  }

  it("sends every statement through one checked-out client and releases it", async () => {
    const r = recordingPool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await new PgStore({ pool: r.pool as any }).writeRun({ run_id: "a", pr: PR, review: REVIEW, events: events(3) });
    expect(r.viaClient[0]).toBe("BEGIN");
    expect(r.viaClient.at(-1)).toBe("COMMIT");
    expect(r.viaClient).toContain("INSERT");
    expect(r.released()).toBe(1);
  });

  it("rolls back on the same client, releases it, and reports the write's own error", async () => {
    const r = recordingPool(/INSERT INTO trace_events/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new PgStore({ pool: r.pool as any });
    await expect(store.writeRun({ run_id: "b", pr: PR, review: REVIEW, events: events(3) })).rejects.toThrow(
      "insert rejected",
    );
    expect(r.viaClient.at(-1)).toBe("ROLLBACK");
    expect(r.viaClient).not.toContain("COMMIT");
    expect(r.released()).toBe(1);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const it_pg = DATABASE_URL ? it : it.skip;

describe("concurrent writers on a real pool (#177; DATABASE_URL required)", () => {
  it_pg("a failed run leaves nothing, and a concurrent good run persists whole", async () => {
    const pg = (await import("pg" as unknown as string)) as {
      Pool: new (cfg: { connectionString: string; max: number }) => {
        query(t: string, p?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
        end(): Promise<void>;
      };
    };
    const pool = new pg.Pool({ connectionString: DATABASE_URL as string, max: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new PgStore({ pool: pool as any });
    const tag = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const good = `${tag}-good`;
    const bad = `${tag}-bad`;
    try {
      const results = await Promise.allSettled([
        store.writeRun({ run_id: bad, pr: PR, review: REVIEW, events: events(10, true) }),
        store.writeRun({ run_id: good, pr: PR, review: REVIEW, events: events(2) }),
      ]);
      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("fulfilled");
      const count = async (id: string) => {
        const runs = await pool.query("SELECT count(*)::int AS n FROM runs WHERE run_id = $1", [id]);
        const evs = await pool.query("SELECT count(*)::int AS n FROM trace_events WHERE run_id = $1", [id]);
        return [runs.rows[0]!.n, evs.rows[0]!.n];
      };
      expect(await count(bad)).toEqual([0, 0]);
      expect(await count(good)).toEqual([1, 2]);
    } finally {
      await pool.query("DELETE FROM runs WHERE run_id = ANY($1)", [[good, bad]]);
      await pool.end();
    }
  });
});
