-- Schema for agent trace persistence (issue #6).
--
-- Two tables:
--   runs           one row per agent invocation (PR + timing + cost summary).
--   trace_events   one row per `TraceEvent` from `src/agent/trace.ts`.
--
-- The shapes mirror the TS in-memory `Trace` so the migration from
-- MemoryStore → PgStore is a serialization step, not a rewrite. Payloads
-- land in `jsonb` (not separate columns per variant) because the
-- TraceEvent union has nine variants and column-per-variant would force
-- every schema change into a migration; jsonb keeps the schema small and
-- the discriminant explicit in `kind`.
--
-- Cost columns on `runs` are computed at finalize-time by aggregating
-- `aggregateCost()` over the run's observations and writing the total
-- back. This makes the list-runs query a single index scan rather than
-- needing to recompute on every UI load.

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  pr_owner          TEXT NOT NULL,
  pr_repo           TEXT NOT NULL,
  pr_number         INTEGER NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  finalized_at      TIMESTAMPTZ,
  status            TEXT NOT NULL CHECK (status IN ('running','finalized','aborted')),
  total_cost_dollars NUMERIC(12, 6) NOT NULL DEFAULT 0,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  recommendation    TEXT,
  summary           TEXT
);

CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS runs_pr_idx ON runs (pr_owner, pr_repo, pr_number);

CREATE TABLE IF NOT EXISTS trace_events (
  id        BIGSERIAL PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  ts        BIGINT NOT NULL,         -- clock value as emitted by Trace
  kind      TEXT NOT NULL,
  payload   JSONB NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS trace_events_run_seq_idx ON trace_events (run_id, seq);
CREATE INDEX IF NOT EXISTS trace_events_kind_idx ON trace_events (kind);
