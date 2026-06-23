/**
 * Postgres-backed `TraceStore` (#6).
 *
 * The `pg` package is lazy-imported inside `connect()` so this module
 * loads cleanly in environments that don't have it installed — same
 * pattern as `AnthropicGenerator` in `rag-production-kit`. The intent:
 * developers running unit tests never need a Postgres install; only the
 * `pg-integration` CI job and the `npm run trace:server` demo path
 * actually require it.
 *
 * Schema is in `infra/postgres/init.sql`. Migrations are not a concern in
 * v0 — the schema lands fully formed and any change is a hand-rolled
 * SQL revision in the same file (the trace store is a debug/telemetry
 * surface, not a customer-facing data store).
 */

import { aggregateCost, type RunDetail, type RunSummary, type TraceStore, type WriteRunInput } from "./store.js";
import type { TraceEvent } from "../agent/trace.js";

// Minimal subset of `pg.Pool` we use, captured as an interface so this
// file doesn't pull `@types/pg` into the broader type-graph. The real
// `pg` is imported via dynamic `import()` to keep it out of the dep
// graph until someone actually constructs a `PgStore`.
interface PoolLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export interface PgStoreOptions {
  connectionString?: string;
  /** Inject a pre-built Pool (used by tests against `pg-mem`). */
  pool?: PoolLike;
}

export class PgStore implements TraceStore {
  private pool: PoolLike | null = null;
  private readonly opts: PgStoreOptions;

  constructor(opts: PgStoreOptions = {}) {
    this.opts = opts;
    if (opts.pool) this.pool = opts.pool;
  }

  private async getPool(): Promise<PoolLike> {
    if (this.pool) return this.pool;
    const connectionString =
      this.opts.connectionString ?? process.env.DATABASE_URL ?? "postgresql://agent:agent@localhost:5433/agent_trace";
    // Dynamic import keeps `pg` out of the require/import graph until
    // actually needed; module is optional from the package consumer's POV.
    const mod = await import("pg" as unknown as string).catch(() => null);
    if (!mod) {
      throw new Error(
        "PgStore: the 'pg' package is not installed. Run `npm install pg` to enable Postgres-backed traces, or use MemoryStore for hermetic tests.",
      );
    }
    const PoolCtor = (mod as { Pool: new (cfg: { connectionString: string }) => PoolLike }).Pool;
    this.pool = new PoolCtor({ connectionString });
    return this.pool;
  }

  async writeRun(input: WriteRunInput): Promise<void> {
    const pool = await this.getPool();
    const total = aggregateCost(input.events);
    const startedAt = startedAtIso(input.events);
    const finalizedAt = finalizedAtIso(input.events);
    const status = deriveStatus(input.events);

    await pool.query("BEGIN", []);
    try {
      await pool.query(
        `INSERT INTO runs (run_id, pr_owner, pr_repo, pr_number, started_at, finalized_at, status,
                           total_cost_dollars, total_input_tokens, total_output_tokens,
                           recommendation, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (run_id) DO UPDATE SET
           started_at   = EXCLUDED.started_at,
           finalized_at = EXCLUDED.finalized_at,
           status       = EXCLUDED.status,
           total_cost_dollars = EXCLUDED.total_cost_dollars,
           total_input_tokens = EXCLUDED.total_input_tokens,
           total_output_tokens = EXCLUDED.total_output_tokens,
           recommendation = EXCLUDED.recommendation,
           summary        = EXCLUDED.summary`,
        [
          input.run_id,
          input.pr.owner,
          input.pr.repo,
          input.pr.number,
          startedAt,
          finalizedAt,
          status,
          total.dollars,
          total.input_tokens,
          total.output_tokens,
          input.review.recommendation,
          input.review.summary,
        ],
      );
      // Idempotent re-write: clear prior events for this run, then bulk-insert
      // the fresh log. The trace is immutable by convention so this only fires
      // on a manual replay scenario.
      await pool.query("DELETE FROM trace_events WHERE run_id = $1", [input.run_id]);
      for (let i = 0; i < input.events.length; i += 1) {
        const ev = input.events[i];
        if (!ev) continue;
        await pool.query(
          `INSERT INTO trace_events (run_id, seq, ts, kind, payload)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [input.run_id, i, ev.ts, ev.kind, JSON.stringify(payloadOf(ev))],
        );
      }
      await pool.query("COMMIT", []);
    } catch (err) {
      await pool.query("ROLLBACK", []);
      throw err;
    }
  }

  async listRuns(opts: { limit?: number; offset?: number } = {}): Promise<RunSummary[]> {
    const pool = await this.getPool();
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const { rows } = await pool.query<RunRow>(
      `SELECT run_id, pr_owner, pr_repo, pr_number, started_at, finalized_at, status,
              total_cost_dollars, total_input_tokens, total_output_tokens, recommendation, summary
       FROM runs
       ORDER BY started_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(rowToSummary);
  }

  async getRun(runId: string): Promise<RunDetail | null> {
    const pool = await this.getPool();
    const summary = await pool.query<RunRow>(
      `SELECT run_id, pr_owner, pr_repo, pr_number, started_at, finalized_at, status,
              total_cost_dollars, total_input_tokens, total_output_tokens, recommendation, summary
       FROM runs WHERE run_id = $1`,
      [runId],
    );
    if (summary.rows.length === 0) return null;
    const events = await pool.query<EventRow>(
      `SELECT seq, ts, kind, payload FROM trace_events WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return {
      ...rowToSummary(summary.rows[0] as RunRow),
      events: events.rows.map(eventRowToTraceEvent),
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

// ---- row shapes ------------------------------------------------------

interface RunRow {
  run_id: string;
  pr_owner: string;
  pr_repo: string;
  pr_number: number;
  started_at: Date | string;
  finalized_at: Date | string | null;
  status: RunSummary["status"];
  total_cost_dollars: string | number;
  total_input_tokens: string | number;
  total_output_tokens: string | number;
  recommendation: string | null;
  summary: string | null;
}

interface EventRow {
  seq: number;
  ts: string | number;
  kind: string;
  payload: unknown;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function toNum(v: string | number): number {
  return typeof v === "string" ? Number(v) : v;
}

function rowToSummary(r: RunRow): RunSummary {
  return {
    run_id: r.run_id,
    pr: { owner: r.pr_owner, repo: r.pr_repo, number: r.pr_number },
    started_at: toIso(r.started_at) ?? new Date().toISOString(),
    finalized_at: toIso(r.finalized_at),
    status: r.status,
    total_cost: {
      input_tokens: toNum(r.total_input_tokens),
      output_tokens: toNum(r.total_output_tokens),
      dollars: toNum(r.total_cost_dollars),
    },
    recommendation: (r.recommendation ?? null) as RunSummary["recommendation"],
    summary: r.summary,
  };
}

function eventRowToTraceEvent(r: EventRow): TraceEvent {
  const payload = r.payload as Record<string, unknown>;
  return { ts: Number(r.ts), kind: r.kind, ...payload } as TraceEvent;
}

function payloadOf(event: TraceEvent): Record<string, unknown> {
  // Strip the `ts` + `kind` discriminants; everything else is the payload.
  const { ts: _ts, kind: _kind, ...rest } = event as TraceEvent & Record<string, unknown>;
  void _ts;
  void _kind;
  return rest;
}

function startedAtIso(events: TraceEvent[]): string {
  const start = events.find((e) => e.kind === "run_started");
  return start ? new Date(start.ts).toISOString() : new Date().toISOString();
}

function finalizedAtIso(events: TraceEvent[]): string | null {
  const end = [...events].reverse().find((e) => e.kind === "finalized" || e.kind === "aborted");
  return end ? new Date(end.ts).toISOString() : null;
}

function deriveStatus(events: TraceEvent[]): RunSummary["status"] {
  if (events.some((e) => e.kind === "aborted")) return "aborted";
  if (events.some((e) => e.kind === "finalized")) return "finalized";
  return "running";
}
