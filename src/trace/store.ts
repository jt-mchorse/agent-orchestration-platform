import type { TraceEvent } from "../agent/trace.js";
import type { PlannerState, Review, StepCost } from "../agent/types.js";

/**
 * Run-level summary the UI reads from the `runs` list endpoint.
 *
 * Mirrors the columns on the `runs` table in `infra/postgres/init.sql`,
 * plus a `total_cost` aggregate. `finalized_at`/`recommendation`/`summary`
 * are nullable because a run may be in-flight (not yet finalized) or
 * aborted (the planner still emits a partial review, so they're usually
 * populated, but the schema doesn't require it).
 */
export interface RunSummary {
  run_id: string;
  pr: { owner: string; repo: string; number: number };
  started_at: string;
  finalized_at: string | null;
  status: "running" | "finalized" | "aborted";
  total_cost: AggregatedCost;
  recommendation: Review["recommendation"] | null;
  summary: string | null;
}

export interface AggregatedCost {
  input_tokens: number;
  output_tokens: number;
  dollars: number;
}

/**
 * One run's full payload: the summary plus the chronological event log.
 *
 * What the UI's run-detail screen consumes. Events are deserialized back
 * to the same `TraceEvent` union the executor emits, so the UI's
 * rendering code doesn't need to know whether it's reading from memory or
 * Postgres.
 */
export interface RunDetail extends RunSummary {
  events: TraceEvent[];
}

/**
 * Sum step-level `cost` across the observations in a run.
 *
 * Skips missing fields rather than treating them as zero — so a partial
 * cost report shows up as a partial total, not a misleading "$0.00".
 * If no observation reports any cost at all, the result is all zeros.
 *
 * A non-finite (NaN/Infinity) or negative value is skipped the same way: a
 * bare `typeof === "number"` check passes for `NaN` (and `Infinity`, and
 * negatives), so a single corrupt observation would otherwise poison the
 * whole run's aggregate (`x += NaN` → `NaN`) that gets persisted and rendered
 * on the run-detail screen. Counting only finite, non-negative costs matches
 * the finite-and-non-negative contract the rest of the repo enforces
 * (`RetryPolicy.backoffMs`, the negative-fixture-count guard) while keeping
 * this aggregator's "skip what you can't trust → partial total" posture.
 */
/**
 * The `runs` columns these aggregates land in, from `infra/postgres/init.sql`:
 *
 *     total_cost_dollars  NUMERIC(12, 6) NOT NULL DEFAULT 0,
 *     total_input_tokens  BIGINT         NOT NULL DEFAULT 0,
 *     total_output_tokens BIGINT         NOT NULL DEFAULT 0,
 *
 * Pinned against the DDL by `test/trace/cost-column-domain.test.ts`, which reads
 * `init.sql`, so these constants cannot drift from the schema they describe (#143).
 */
const DOLLARS_SCALE = 6;
const DOLLARS_MAX_EXCLUSIVE = 1_000_000; // NUMERIC(12, 6) holds < 10^(12-6)

/**
 * A token count worth adding: non-negative, and exactly representable in `BIGINT`.
 *
 * `Number.isSafeInteger`, not `Number.isFinite` (#143). The old single predicate
 * was `isFinite(x) && x >= 0` for all three summands, and `total_input_tokens` is
 * `BIGINT`: a fractional count like `1234.5678` was accepted, summed, round-tripped
 * by `MemoryStore` exactly, and could not be stored by `PgStore` at all -- a failure
 * visible only in the `DATABASE_URL`-gated job. That is the same shape, in the same
 * file, one function above the `ts` guard `#141` fixed this morning, and `#142`'s own
 * reasoning transfers verbatim: "`Number.isSafeInteger` is what `BIGINT` receives
 * exactly".
 *
 * A fractional token count is not a small measurement, it is corrupt data -- tokens
 * are counted, not measured -- so skipping it is the right posture and the one this
 * aggregator already documents.
 */
function isCountableTokens(x: number | undefined): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

/**
 * A dollar amount worth adding: non-negative, finite, and individually storable.
 *
 * Deliberately NOT narrowed to six decimals, which is the other half of #143 and the
 * part worth reading twice. A per-step cost of `1.23e-7` is a real sub-microcent
 * token charge, not corrupt data. Skipping it would lose real money from the total,
 * and rounding each observation to the column's scale would round it to zero and
 * lose the same money -- a thousand of them are a tenth of a cent that belongs in
 * the report. So individual values are summed at full precision and the TOTAL is
 * quantised once, by `quantiseDollars` below.
 *
 * The magnitude bound is different in kind: `NUMERIC(12, 6)` cannot hold `>= 10^6`
 * at all, and no single agent step costs a million dollars, so a value that large is
 * corrupt in the same way a fractional token count is.
 */
function isCountableDollars(x: number | undefined): x is number {
  return (
    typeof x === "number" &&
    Number.isFinite(x) &&
    x >= 0 &&
    x < DOLLARS_MAX_EXCLUSIVE
  );
}

/**
 * Round a dollars total to the scale `NUMERIC(12, 6)` stores.
 *
 * Applied in the SHARED aggregator rather than in either backend, because that is
 * what makes the two agree. Before #143, `MemoryStore` stored the full-precision
 * float and `PgStore` handed the same float to a `NUMERIC(12, 6)` column, which
 * rounds it silently -- so `getRun` returned a different `dollars` depending on which
 * backend answered. `#139`/`#140` moved the three derivations into one definition
 * precisely so "the two backends of this interface can't disagree"; this is the same
 * requirement reached through the cost column instead of through `status`.
 *
 * Quantising the total and not each summand is what keeps the sub-microcent charges
 * the `isCountableDollars` comment is about.
 */
function quantiseDollars(total: number): number {
  return Number(total.toFixed(DOLLARS_SCALE));
}

export function aggregateCost(events: TraceEvent[]): AggregatedCost {
  let input = 0;
  let output = 0;
  let dollars = 0;
  for (const e of events) {
    if (e.kind !== "observation") continue;
    const c: StepCost | undefined = e.observation.cost;
    if (!c) continue;
    if (isCountableTokens(c.input_tokens)) input += c.input_tokens;
    if (isCountableTokens(c.output_tokens)) output += c.output_tokens;
    if (isCountableDollars(c.dollars)) dollars += c.dollars;
  }
  // `dollars` quantised once, at the end (#143, D-015). Summing at full precision
  // and rounding here keeps a sub-microcent per-step charge in the total while
  // making both backends store the same number.
  return { input_tokens: input, output_tokens: output, dollars: quantiseDollars(dollars) };
}

/**
 * A persisted run that's ready to be written: the run-level metadata
 * plus the chronological events. The `aborted`-vs-`finalized` status is
 * derived from the events (presence of `aborted`).
 */
export interface WriteRunInput {
  run_id: string;
  pr: PlannerState["pr"];
  events: TraceEvent[];
  review: Review;
}

/**
 * Storage seam for trace runs.
 *
 * The contract is intentionally small: write a finalized run, list
 * recent runs (with pagination), fetch one run by id. No streaming
 * writes (D-005 candidate) — the in-memory `Trace` is the streaming
 * surface; the store is the at-rest surface.
 */
export interface TraceStore {
  /**
   * Persist a finalized run.
   *
   * **A re-write under an existing `run_id` replaces the whole run** (#129) —
   * every field of `WriteRunInput`, not a subset. `MemoryStore` gets this from
   * `Map.set`; `PgStore`'s upsert has to list every non-key column in its
   * `ON CONFLICT ... DO UPDATE SET`, and for a while it listed 8 of 11, so a
   * replay kept the old `pr` while its own re-inserted event log carried the
   * new one. An implementation that cannot replace the whole row must not
   * silently keep half of it.
   */
  writeRun(input: WriteRunInput): Promise<void>;
  listRuns(opts?: { limit?: number; offset?: number }): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunDetail | null>;
}

/** Resolved pagination window: `limit` positive, `offset` non-negative. */
export interface PaginationWindow {
  limit: number;
  offset: number;
}

/**
 * Validate and default a `listRuns` pagination window.
 *
 * `listRuns` was the one public API in this repo without the positive-integer
 * contract that `AgentRun`'s `maxReplans`, the eval runner's `--pr` (#107) and
 * the tools' bounds all enforce — and the omission was worse here than a raw
 * throw would be, because `MemoryStore` paginates with `Array.slice`, whose
 * behaviour on a bad value is *silently wrong* rather than an error (#117):
 *
 * ```
 * baseline      -> r3,r2,r1
 * {limit:-1}    -> r3,r2     // silently drops the oldest run
 * {limit:2.5}   -> r3,r2     // silently truncates
 * {limit:NaN}   -> (empty)   // looks like "no runs exist"
 * {offset:-1}   -> r1        // the OLDEST run, skipping the two newest
 * ```
 *
 * The `offset:-1` row is the sharp one: not an error and not a prefix, but a
 * *different* page than any valid offset returns. A caller paginating with a
 * computed offset that goes negative gets a plausible page of the wrong rows —
 * the same "drop or duplicate a run across page boundaries" corruption the
 * `run_id` tie-breaker in the sort was added to prevent, reached through the
 * arguments instead.
 *
 * Lives beside the `TraceStore` interface, and is called by every
 * implementation, so a backend added later inherits the check rather than
 * re-deriving it. `PgStore` would have surfaced most of these as a Postgres
 * error (`LIMIT must not be negative`) rather than bad data, which is the
 * two-backend divergence #97 and llm-cost-optimizer#131 are shaped like;
 * validating here makes both agree regardless.
 *
 * Throws rather than clamping on purpose. The UI clamps at its own boundary
 * (`clampNumber` in `src/ui/server.ts`), which is right for HTTP query params;
 * a library caller passing `-1` has a bug and should hear about it.
 */
export function assertPaginationOpts(
  opts: { limit?: number; offset?: number } = {},
): PaginationWindow {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(
      `listRuns: limit must be a positive integer; got ${describe(opts.limit)}`,
    );
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(
      `listRuns: offset must be a non-negative integer; got ${describe(opts.offset)}`,
    );
  }
  return { limit, offset };
}

function describe(value: unknown): string {
  return typeof value === "number" ? String(value) : `${typeof value} ${String(value)}`;
}

/**
 * The three run-level facts derived from an event log, shared by both
 * `TraceStore` backends (#139).
 *
 * `MemoryStore` stores what these return; `PgStore` writes them to the
 * `started_at` / `finalized_at` / `status` columns. They were two identical
 * copies — `pg-store.ts` had its own `deriveStatus`, `startedAtIso` and
 * `finalizedAtIso` — while `aggregateCost` and `assertPaginationOpts`, the two
 * other rules both backends need, were already shared. Nothing recorded why
 * three of the five went the other way.
 *
 * The copies agreed on every input, so this removes no live defect. It removes
 * the shape that produced one: #129's own comment describes a subset-updating
 * upsert as the two backends "disagreeing about what `writeRun` means", and
 * #117's says of the pagination window that sharing the validator is what stops
 * them disagreeing about a bad one. `deriveStatus` is the costliest of the
 * three to get wrong, because its output is *also* constrained at the database
 * (`status TEXT NOT NULL CHECK (status IN ('running','finalized','aborted'))`),
 * so a fourth status invented on the memory side would pass every hermetic test
 * and fail only in the `DATABASE_URL`-gated job.
 */
/**
 * The `ts` domain, in one place, for both backends (#141).
 *
 * #140 promoted the three derivations below from per-backend copies to one
 * shared definition, on the argument that the two `TraceStore` backends must
 * not "disagree about what `writeRun` means". What it shared was an unguarded
 * input domain: `TraceEvent.ts` is a `number` produced by a **public,
 * pluggable** `Clock`, and nothing validated what a clock returns before
 * `new Date(ts).toISOString()` saw it. Measured:
 *
 *     clock                        emitted        deriveStartedAt
 *     integral (Date.now)          1700000000000  2023-11-14T22:13:20.000Z
 *     fractional (performance.now) 1234.5678      1970-01-01T00:00:01.234Z
 *     NaN                          NaN            THREW RangeError
 *     Infinity                     Infinity       THREW RangeError
 *
 * The non-finite rows threw `RangeError: Invalid time value` — naming no
 * function, no field and no value — and it escaped `writeRun` on *both*
 * backends, which is the parity #140 delivered, on a crash. The fractional row
 * is the silent one: `1234.5678` survives `MemoryStore`'s round trip exactly
 * while the summary reads `...01.234Z`, so the stored event and the derived
 * summary disagree about when the run started — and
 * `infra/postgres/init.sql` declares `ts BIGINT NOT NULL`, which cannot hold
 * it at all, a failure visible only in the `DATABASE_URL`-gated job.
 *
 * The rule is the INTERSECTION of two constraints, and neither implies the
 * other. `Number.isSafeInteger` is what the `BIGINT` column can receive
 * exactly and what `toISOString()` renders without dropping a sub-millisecond
 * part — `Number.isFinite` alone admits `1234.5678`. And `Date`'s own range
 * (+/-8.64e15) is *narrower* than the safe integers, so `MAX_SAFE_INTEGER` is
 * a safe integer that `toISOString()` still refuses; the second clause is
 * spelled as the round trip `Date` actually performs rather than as a
 * constant.
 *
 * Negative is deliberately legal — a pre-epoch instant is a real instant and
 * `BIGINT` holds it, so refusing it would be new strictness rather than parity
 * with the column.
 *
 * The message shape is `assertPaginationOpts`'s, deliberately. That function
 * sits two definitions up, is shared for the identical stated reason (#117:
 * "from the same validator, so the two backends of this interface can't
 * disagree"), validates its numeric inputs with exactly this predicate, and
 * throws exactly this error type *with a message*. `ts` threw the same error
 * type by accident. Two numeric inputs in one file should not report
 * differently.
 *
 * Checked here rather than in `Trace.emit`: `writeRun` accepts an events array
 * from any caller, so a guard in `emit` would leave
 * `store.writeRun({ events: [...] })` — the road every test and both stores
 * already use — unguarded.
 */
function assertEventTs(fn: string, event: TraceEvent): number {
  // Two constraints, not one, and `Number.isSafeInteger` alone is not enough.
  // `Number.MAX_SAFE_INTEGER` (9.007e15) IS a safe integer and is outside
  // `Date`'s representable range (+/-8.64e15), so `new Date(ts).getTime()` is
  // `NaN` and `toISOString()` still throws -- my first spelling of this guard
  // let it through, and the boundary row in
  // `test/trace/event-ts-domain.test.ts` is what said so. The renderability
  // half is written as the round trip it actually needs rather than as a magic
  // constant, so it cannot drift from what `Date` does.
  if (!Number.isSafeInteger(event.ts) || Number.isNaN(new Date(event.ts).getTime())) {
    throw new RangeError(
      `${fn}: event.ts must be a safe integer (ms since epoch); got ${describe(event.ts)} ` +
        `on a ${event.kind} event. The clock passed to \`new Trace({ clock })\` must ` +
        `return whole milliseconds — \`performance.now()\` returns a fractional value, ` +
        `which \`toISOString()\` truncates and the \`ts BIGINT\` column cannot hold.`,
    );
  }
  return event.ts;
}

export function deriveStatus(events: TraceEvent[]): RunSummary["status"] {
  // No `assertEventTs` here, and that is deliberate rather than an omission:
  // this rule reads only `kind`, so a bad `ts` cannot change its answer. The
  // two derivations below read `ts` and are guarded (#141).
  //
  // `aborted` is the explicit budget-exhaustion signal from the executor.
  // It's emitted *before* `finalized`, so we check for it first.
  if (events.some((e) => e.kind === "aborted")) return "aborted";
  if (events.some((e) => e.kind === "finalized")) return "finalized";
  return "running";
}

export function deriveStartedAt(events: TraceEvent[]): string {
  // `run_started` is always the first event the executor emits.
  const start = events.find((e) => e.kind === "run_started");
  if (!start) {
    // Defensive: an empty events list isn't a real run; the caller
    // should have validated this before reaching the store, but rather
    // than throw we fall back to "now" so the UI still has a sortable
    // timestamp.
    return new Date().toISOString();
  }
  return new Date(assertEventTs("deriveStartedAt", start)).toISOString();
}

export function deriveFinalizedAt(events: TraceEvent[]): string | null {
  // Either `finalized` (clean exit) or `aborted` (budget exhaustion)
  // marks the end of a run.
  const end = [...events].reverse().find((e) => e.kind === "finalized" || e.kind === "aborted");
  return end ? new Date(assertEventTs("deriveFinalizedAt", end)).toISOString() : null;
}

function summarize(input: WriteRunInput): Omit<RunSummary, "total_cost"> {
  return {
    run_id: input.run_id,
    pr: input.pr,
    started_at: deriveStartedAt(input.events),
    finalized_at: deriveFinalizedAt(input.events),
    status: deriveStatus(input.events),
    recommendation: input.review.recommendation,
    summary: input.review.summary,
  };
}

/**
 * Deep-copy a list of trace events. A plain `[...events]` copies only the
 * array — every event *object* (and its nested `step`/`plan`/`observation`/
 * `ToolError` payload) stays shared by reference, so a caller holding a
 * returned event (or the objects it passed to `writeRun`) could mutate the
 * stored history. Round-tripping through JSON isolates every level AND matches
 * `PgStore`'s JSONB serialization semantics exactly (it honors each object's
 * `toJSON`, e.g. `ToolError.toJSON`), so the two backends stay in parity.
 * Events are JSON-serializable by construction — PgStore stores them as JSONB.
 */
function cloneEvents(events: readonly TraceEvent[]): TraceEvent[] {
  return JSON.parse(JSON.stringify(events)) as TraceEvent[];
}

/**
 * Return a summary with fresh copies of its two mutable nested objects,
 * `pr` and `total_cost`. Every other field is an immutable primitive.
 *
 * `cloneEvents` (above) closes the aliasing hazard on the event log (#97),
 * but the summary's `pr` and `total_cost` objects were still shared by
 * reference: `writeRun` stored the caller's `input.pr` directly (ingress),
 * and `getRun`/`listRuns` returned the stored objects via a shallow spread
 * (egress), so a caller could mutate committed trace state by holding a
 * reference — exactly what the `MemoryStore` docstring promises it can't.
 * `PgStore` rebuilds both objects from row columns on every read, so
 * copying them here keeps the two backends in parity. A per-field spread is
 * enough because `pr` (`owner`/`repo`/`number`) and `total_cost`
 * (`input_tokens`/`output_tokens`/`dollars`) are flat objects of primitives.
 */
function cloneSummaryRefs<T extends RunSummary>(summary: T): T {
  return { ...summary, pr: { ...summary.pr }, total_cost: { ...summary.total_cost } };
}

/**
 * In-memory `TraceStore` for tests and the demo server. Same contract
 * as `PgStore`; tests assert against this without spinning up Postgres.
 *
 * Defensive DEEP copies on write+read so callers can't mutate the stored
 * state by holding a reference — neither by mutating the objects they passed
 * to `writeRun` nor by mutating an event returned from `getRun`.
 */
export class MemoryStore implements TraceStore {
  private readonly runs = new Map<string, RunDetail>();

  async writeRun(input: WriteRunInput): Promise<void> {
    const summary = summarize(input);
    const total_cost = aggregateCost(input.events);
    // `cloneSummaryRefs` isolates `pr` from the caller's `input.pr` (ingress);
    // `total_cost` is already fresh from `aggregateCost`, and `events` is
    // deep-copied by `cloneEvents`. See #97 for the sibling event-log fix.
    const detail: RunDetail = cloneSummaryRefs({
      ...summary,
      total_cost,
      events: cloneEvents(input.events),
    });
    this.runs.set(input.run_id, detail);
  }

  async listRuns(opts: { limit?: number; offset?: number } = {}): Promise<RunSummary[]> {
    // Before `slice` gets hold of them — a bad value there is a silently wrong
    // page, not an error (#117).
    const { limit, offset } = assertPaginationOpts(opts);
    const all = [...this.runs.values()]
      // Tie-break on the unique run_id so equal started_at timestamps (two runs
      // started in the same ms) get a deterministic, stable order — otherwise
      // paginated reads can drop or duplicate a run across page boundaries.
      // Kept in parity with PgStore's `ORDER BY started_at DESC, run_id ASC`.
      .sort(
        (a, b) =>
          b.started_at.localeCompare(a.started_at) || a.run_id.localeCompare(b.run_id),
      )
      .map((d) => {
        const { events: _events, ...rest } = d;
        void _events;
        // Fresh `pr`/`total_cost` so a caller mutating a returned summary
        // can't corrupt the stored run or another reader's view (egress).
        return cloneSummaryRefs(rest);
      });
    return all.slice(offset, offset + limit);
  }

  async getRun(runId: string): Promise<RunDetail | null> {
    const detail = this.runs.get(runId);
    if (!detail) return null;
    // Deep-copy `events` and freshen `pr`/`total_cost` so a caller mutating
    // the returned detail can't corrupt the stored run or a later read (egress).
    return cloneSummaryRefs({ ...detail, events: cloneEvents(detail.events) });
  }
}
