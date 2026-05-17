# Architecture

The agent's shape is locked by the use-case decision (D-002, see
[`use-case.md`](./use-case.md)): **PR review agent**. Every component below
is sized for that single purpose.

```mermaid
flowchart TD
  IN[(PR identifier:<br/>owner/repo#N or fixture path)]
  OP[operator]

  subgraph AGENT["Agent loop (issue #3 — shipped)"]
    P[Planner.initialPlan / revise / finalize]
    E[AgentRun executor]
    R[Re-plan trigger<br/>tool_error | approval_denied]
  end

  subgraph TOOLS["Tool registry (issue #2)"]
    T1[fetch_pr]
    T2[read_file_at_ref]
    T3[search_repo]
    T4[run_check]
    T5[(MCP: portfolio-context)]
  end

  subgraph CHECKPOINT["HITL checkpoint (issue #4)"]
    C[Pause + render comment]
    APPROVE{operator approves?}
  end

  subgraph TRACE["Trace store (issue #6 — shipped)"]
    DB[(Postgres: runs + trace_events)]
    UI[React-via-CDN viewer]
  end

  subgraph EVAL["Eval suite (issue #7 — shipped)"]
    GOLDEN[(Golden answer keys)]
    JUDGE[scoreReview → ReviewScore]
  end

  IN --> P
  P --> E
  E <--> TOOLS
  E --> R
  R --> P
  E --> C
  C --> APPROVE
  APPROVE -- yes --> POST[Post comment on PR]
  APPROVE -- no --> ABORT[Abort run]
  AGENT -. log .-> DB
  CHECKPOINT -. log .-> DB
  DB --> UI
  OP --> APPROVE
  OP --> UI
  GOLDEN --> JUDGE
  DB --> JUDGE
```

## Locked by this PR (issue #1)

- **Use case** — PR review agent, not research brief. (D-002.)
- **Input shape** — `fixtures/sample-prs/<slug>.json` with the v1 schema
  documented in [`fixtures/sample-prs/SCHEMA.md`](../fixtures/sample-prs/SCHEMA.md).
- **Output shape** — summary paragraph + severity-tagged findings + final
  recommendation, structured per [`use-case.md`](./use-case.md).
- **Tool contract** — five named tools (one of them a custom MCP server)
  with knowable signatures listed in `use-case.md`.

## Pending downstream (open issues)

_(All v0.1 issues shipped.)_

## Eval suite (this PR — issue #7)

`src/eval/` ships three modules:

- **`score.ts`** — `scoreReview(actual, golden)` returns a
  `ReviewScore` with three sub-metrics: exact-class recommendation
  match (0/1), findings F1 against a severity-keyed 1:1 fuzzy match
  (D-011), and a summary length-ratio. Composite is
  `0.5×rec + 0.4×f1 + 0.1×length`.
- **`runner.ts`** — `discoverCases(fixturesDir)` finds every
  fixture/golden pair; `evaluateAll(cases)` runs the agent (with the
  ScriptedPlanner placeholder; `AnthropicPlanner` swaps in here) and
  scores each.
- **`comment.ts`** — `renderEvalMarkdown(run)` produces a sticky-marker
  markdown table; `upsertStickyComment(repo, pr, body)` finds + edits
  the prior comment by hidden marker (`<!-- agent-eval:sticky-comment -->`)
  or POSTs a new one.

The `agent-eval` GitHub Action wires these together: on every PR it
runs the eval against the committed fixtures, prints the markdown to
the action log, and upserts the sticky comment.

**TS-only, not Python (D-010).** llm-eval-harness's `comment` CLI is
Python; replicating the same pattern in TS keeps the agent's CI
dep-light. The sticky-marker idea is borrowed; the two repos use
distinct markers so a downstream consumer importing both doesn't
collide.

## Trace persistence + viewer (this PR — issue #6)

Two tables in `infra/postgres/init.sql`:

- `runs` — one row per agent invocation. PR coordinates, started_at /
  finalized_at, `status ∈ {running, finalized, aborted}`, aggregated
  cost (`total_cost_dollars` NUMERIC + token totals), plus the
  finalized review's recommendation and summary so the list endpoint
  is a single index scan.
- `trace_events` — one row per `TraceEvent`. Payload lands in `jsonb`
  rather than columns-per-variant; the union has nine variants and
  payload shapes change frequently as new tools land.

`TraceStore` is the seam: `MemoryStore` for hermetic tests, `PgStore`
for real persistence (`pg` is lazy-imported, kept in
`optionalDependencies`). Both implement `writeRun`/`listRuns`/`getRun`
identically. `aggregateCost(events)` sums each `Observation.cost`
field across the run, skipping missing values rather than treating
them as zero so a partial cost report shows as a partial total — D-005.

The viewer (`src/ui/`) is React 18 loaded via ESM CDN + `htm` for
JSX-free templating. No bundler, no npm-side React dep — same
dep-discipline reasoning as the stdlib `http.server` for the SSE demo
in `rag-production-kit` (D-006). One list screen, one run-detail
screen with a chronological timeline keyed off the event `kind`. Run
locally with `npm run trace:server -- --memory` (seeds two sample runs)
or against `DATABASE_URL` (Postgres).

The CI `pg-integration` job brings up a Postgres service container,
applies `init.sql`, and runs `test/trace/pg-store.test.ts` against
real Postgres. Local unit tests stay hermetic (skip when
`DATABASE_URL` isn't set).

## Agent loop (this PR — issue #3)

The loop is three TS modules under `src/agent/`:

```ts
interface Planner {
  initialPlan(input: PlannerState["pr"]): Promise<Plan>;
  revise(state: PlannerState, reason: ReplanReason): Promise<Plan>;
  finalize(state: PlannerState): Promise<Review>;
}

class AgentRun {
  // Walks plan.steps in order; on a thrown ToolError, asks the planner
  // to revise and resumes from the new plan's first step. Bounded by a
  // configurable max-replan budget (default 5).
  async run(pr: { owner; repo; number }): Promise<Review>;
}

class Trace {
  // Append-only event log: run_started · plan_emitted ·
  // step_started · observation · re_plan_triggered · finalized | aborted.
  // Pluggable clock for deterministic tests; the same shape #6 will
  // persist to Postgres.
}
```

Two re-plan triggers ship today: `tool_error` (input/output validation,
`internal`, `not_found`, `unsupported_in_replay`) and `approval_denied`
(destructive-tool path from #4). They're modeled as distinct `ReplanReason`
variants so a planner can branch on them — e.g., revise the input shape
on validation failure but skip a posting step entirely on a denial.

`ScriptedPlanner` is the test-utility planner: a canned initial plan, an
optional list of revision callbacks, and a final-review callback. Tests
prove that the loop's decisions (every `PlannedStep.rationale`) show up in
the trace, that re-plan kicks in on errors and approval denials, that the
budget bounds runaway loops, and that an end-to-end run wires up the real
`buildDefaultRegistry()` against the committed PR fixture.

The LLM-driven `AnthropicPlanner` is deliberately not in this PR — it
needs the trace persistence from #6 and the eval coverage from #7 to be
worth landing; ScriptedPlanner is sufficient to exercise the loop and
verify its contract.

## Recovery layers (this PR — issue #5)

`AgentRun.runStepWithRetryAndFallback` wraps every step in three
recovery layers, executed in order. The planner sees exactly one
`Observation` per step; retries and fallbacks land in the trace as
their own events.

```
step
  └─ withRetry(primary)            ← layer 1: retry on transient ToolError
       └─ on exhaustion, if primary.annotations.fallbackTo:
            └─ withRetry(fallback) ← layer 2: one-hop alternative
                 └─ on exhaustion: replan layer (existing)
```

Configuration lives on the tool itself (D-012):

```ts
{
  retry: {
    maxAttempts: 3,
    backoffMs: 100,
    backoffMultiplier: 2,                 // default 2.0
    retryableErrorKinds: ["internal"],    // default; override per-tool
  },
  fallbackTo: "alternative_tool_name",    // must be in the same registry
}
```

Trace events surfaced by this layer:
- `retry_attempted` — `{ toolName, attempt, backoffMs, error }`. One per
  failed attempt that will be retried.
- `fallback_used` — `{ from, to, error }`. One when retries on the
  primary exhaust and a `fallbackTo` is declared.

Only one hop of fallback is followed. The fallback's *own* `fallbackTo`
is ignored — that makes cycles impossible by construction and keeps the
recovery tree shallow enough that humans can reason about a misbehaving
agent without reading the trace twice.

When a `fallbackTo` points at an unregistered tool, the executor
surfaces it as an `internal` `ToolError` on the step's observation
(naming the orphan) rather than crashing the run — misconfiguration is
visible, and the planner can replan around it.

## Stack

- **TypeScript / Node** for the agent core (per portfolio handoff §2 stack).
- **Anthropic SDK** for model calls.
- **Custom MCP server** (Node) for the `portfolio-context` tool.
- **Postgres** for trace persistence (single container).
- **React** (minimal) for the trace inspection UI.

The TS scaffolding (`package.json`, `tsconfig.json`, vitest, eslint) is
deliberately not added in this PR — it lands with #2 where the first real
code arrives. Adding empty scaffolding now would create dead surface.
