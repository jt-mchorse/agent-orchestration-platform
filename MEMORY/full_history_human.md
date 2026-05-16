# Session History (human-readable)

Chronological log of work sessions. Most recent first below the divider.

---

## 2026-05-15 — Issue #1: lock the agent use case
**Duration:** ~35 min · **Branch:** `session/2026-05-15-0945-issue-01`

- Decided **PR review agent** (D-002) over research brief, with a five-criterion table in `docs/use-case.md` and the alternative explicitly recorded as rejected.
- Committed two real PR fixtures from the portfolio (`vector-search-at-scale#6` Terraform infra and `rag-production-kit#9` hybrid retrieval) under `fixtures/sample-prs/` covering distinct review surfaces (HCL/shell vs. Python implementation), plus a v1 schema doc.
- Backfilled `README.md` "What this is" and replaced placeholders elsewhere; rewrote `docs/architecture.md` with a layered diagram showing what's locked here vs. pending in #2/#3/#4/#6/#7.

**Why this work, this session:** Every downstream issue (#2 tools, #3 planner, #4 HITL, #6 trace UI, #7 evals) targets a specific agent shape; without this decision they all sit blocked on abstract speculation.

**Open questions / blockers:** None. TS scaffolding deliberately deferred to #2 to avoid dead surface.

**Next session:** Issue #2 — implement the five-tool registry whose contracts are now listed in `docs/use-case.md`, including the custom `portfolio-context` MCP server.

---

## 2026-05-15 — Issue #2: tool registry + four PR-review tools
**Duration:** ~65 min · **Branch:** `session/2026-05-15-1908-issue-2`

- Stood up the TypeScript package skeleton (strict tsconfig, vitest, zod for tool schemas, CI workflow upgraded from stub to real typecheck+test on Node 20) and built a generic `ToolRegistry` that validates both inputs and outputs against per-tool zod schemas. Output validation is the load-bearing part: it locks the contract the planner (#3) will rely on.
- Implemented four of the five tools listed in `docs/use-case.md`, all in replay mode against the committed fixtures: `fetch_pr` (load by `owner/repo#number`), `read_file_at_ref` (file-cache lookup, falls back to reconstructing added-status files from fixture patches), `search_repo` (substring match across fixture file paths and patches), `run_check` (CI status from a fixtures/checks/ slug, with a `missing_fixture` sentinel rather than throwing so the agent can branch). Live-mode is stubbed on all four so contracts stay stable when the planner wires the real GitHub client.
- 17 vitest tests across the registry and four tools; full suite runs in ~330 ms.

**Why this work, this session:** Without a stable tool surface, the planner (#3) has nothing to plan against. Building the registry around zod schemas means #3 can wire tools by name without re-deriving contracts.

**Open questions / blockers:** Custom MCP server `portfolio-context` remains open on issue #2 — it's a sizeable deliverable on its own (exposes the target repo's `MEMORY/core_decisions_*.md` to the agent) and benefits from focused time. Will also land in `mcp-server-cookbook` per use-case doc.

**Next session:** Build `portfolio-context` MCP server to close out #2, OR move to #3 (planner) and circle back to the MCP server when its consumers exist.

---

## 2026-05-15 — Issue #2 (continued): portfolio-context MCP server + 5th tool
**Duration:** ~55 min · **Branch:** `session/2026-05-15-1908-issue-2` (continuation)

- Built the custom MCP server under `mcp-server/portfolio-context/`, split into a pure parser (`decisions.ts`, with explicit handling for `null` / `[]` / inline arrays / `#`-prefixed issue refs), an in-process server factory (`server.ts` registering `get_repo_core_decisions`), and a thin stdio bin (`bin.ts`) wired into `package.json`'s `bin` field as `portfolio-context-mcp` for Claude-Desktop-style use. The server validates the requested repo slug against `[A-Za-z0-9_.\-]` before joining to `PORTFOLIO_ROOT` so requests cannot escape the root.
- Added the fifth tool `get_portfolio_context` in `src/tools/`. It uses an injectable `connect` factory; the default embeds the server in-process via `InMemoryTransport` so the agent doesn't need to manage a subprocess. The protocol exchange is real MCP — only the transport differs from production stdio.
- 17 new tests across parser, server (end-to-end via `InMemoryTransport`, including the missing-file and path-escape paths), and registry tool. Total now 34/34 green; typecheck clean; build emits a runnable `dist/mcp-server/portfolio-context/bin.js`. Bumped `zod` minimum to `^3.25` to satisfy the MCP SDK's peer-dep range.

**Why this work, this session:** It was the one acceptance criterion still open on #2 ("MCP server runs locally and is invokable from the agent"). The planner (#3) and eval suite (#7) both benefit from being able to ask "what's the recorded decision context for *this* repo?" against the standard MCP protocol rather than reaching into the filesystem directly.

**Open questions / blockers:** None for #2. Considered mirroring `portfolio-context` into `mcp-server-cookbook` per the use-case doc's aside, but on re-reading the cookbook's §2 spec (4 generic production-pattern servers: Postgres, filesystem-sandbox, API-wrapper, internal-tools-bridge) the portfolio-context server is too repo-specific to belong there — it stays in this repo where its consumer lives.

**Next session:** #3 (planner→executor→re-planner loop) — full tool surface is now available; or #4 (HITL checkpoints), which is independent of the planner shape.

---

## 2026-05-15 — Issue #4: HITL checkpoints for destructive tools
**Duration:** ~35 min · **Branch:** `session/2026-05-15-2322-issue-4`

- Added a `Tool.annotations.destructive` flag (with a required `destructiveReason` enforced at registration) and an `approvals` provider on `ToolContext`. The registry intercepts destructive invocations and throws a typed `ToolError` (`approval_missing` if no provider, `approval_denied` if the provider returned `approved: false`) before the underlying tool runs. The underlying tool only executes on `approved: true`, so a CLI/UI can't accidentally skip the gate.
- Shipped the first real destructive consumer: a `post_review_comment` tool that renders the structured review (summary + findings + recommendation) and returns the preview in replay mode, with live mode stubbed for the planner (#3). This makes the destructive flag a real feature rather than dead config.
- CLI approval helper (`src/agent/cli-approval.ts`) implements the provider contract via stderr prompt + stdin y/n, with two convenience singletons — `autoApproveProvider` (for replay/test paths) and `denyAllProvider` (safe-by-default). 10 new vitest tests across the registry gate, the destructive tool's preview rendering, and the CLI prompt's y / empty paths. Total now 44/44 green.

**Why this work, this session:** With ~100 min left after #2 and a #3-or-#4 fork, taking #4 first means the planner (#3) lands into a registry that already enforces destructive approvals — no follow-up needed to thread the gate through. The strict "lowest unblocked priority:high" selection rule would have chosen #3 (90 min estimated, tight for remaining budget); the deviation is documented in the issue plan comment and noted here.

**Open questions / blockers:** AC2 says "Pause-and-resume mechanic works in CLI + UI." The CLI half is done; the UI half belongs in #6 (trace UI) where the React surface lives. Captured in the issue close comment, not a separate blocker.

**Next session:** #3 (planner→executor→re-planner loop). The registry now enforces approvals; the planner just routes `post_review_comment` through it like any other tool.

## 2026-05-16 — Issue #3: Planner → Executor → Re-planner loop
**Duration:** ~50 min · **Branch:** `session/2026-05-16-0322-issue-3`

- Shipped the agent loop as three small modules under `src/agent/`: `types.ts` (the `Plan`/`PlannedStep`/`Observation`/`PlannerState`/`ReplanReason`/`Review`/`Finding` shapes matching the `docs/use-case.md` contract), `planner.ts` (`Planner` interface and `ScriptedPlanner` test utility — D-003), `trace.ts` (append-only `TraceEvent` log with a pluggable clock, distributed-Omit type to keep the discriminated union sound), and `executor.ts` (`AgentRun` with `DEFAULT_MAX_REPLANS = 5` — D-004).
- The executor walks `plan.steps` in order; on a `ToolError` it asks the planner to `revise(state, reason)` with a `ReplanReason` variant that distinguishes `tool_error` from `approval_denied` so the planner can branch on intent. The trace logs every decision (every `PlannedStep.rationale`) plus `re_plan_triggered` between a failing observation and the next plan, and ends in either `finalized` or `aborted` (`max_replans_exceeded:N`).
- 13 new hermetic tests covering happy path (multi-step plan, rationale-in-trace, empty plan), re-plan (tool error → revise → resume, approval_denied → distinct trigger, budget exhaustion → abort + still finalize), non-`ToolError` re-throw, `PlannerState` accumulation in `revise()` and `finalize()`, `Trace` clock + defensive copy + `ofKind` filtering, and a wired-up integration test that runs `buildDefaultRegistry()` against the committed `rag-production-kit#9` fixture and asserts the executor produced a single plan, no replans, and a real summary derived from the fetched PR. Suite total now 57/57 green.
- `docs/architecture.md` mermaid relabels #3 as shipped and the agent box names `initialPlan / revise / finalize`. New "Agent loop (this PR — issue #3)" subsection documents the interface and the two re-plan triggers. The "Pending downstream" list shrinks to just #6 and #7.
- D-003 (three-method `Planner` interface) and D-004 (replan-budget default 5, configurable) recorded with full alternatives and reasoning.

**Why this work, this session:** #3 is the last *agent-core* piece — #6 and #7 are persistence and evals layered on top. The LLM-driven `AnthropicPlanner` is deliberately deferred (per the plan comment): the loop's contract is testable end-to-end with `ScriptedPlanner` today, and the LLM implementation is much easier to build once #6 gives it traces to learn from and #7 gives it eval gates.

**Open questions / blockers:** None for the loop itself. `AnthropicPlanner` lands alongside #6/#7 (filed separately). PR posting via `post_review_comment` already routes through the registry's destructive gate from #4; the planner just calls the tool like any other one.

**Next session:** Either #6 (Postgres trace persistence + minimal React UI — the `Trace` here is the in-memory shape #6 mirrors) or #7 (eval suite importing `llm-eval-harness`). Both are unblocked.

## 2026-05-16 — Issue #6: Trace observability (Postgres + React-via-CDN viewer)
**Duration:** ~65 min · **Branch:** `session/2026-05-16-0333-issue-6`

- Shipped the trace persistence layer in `infra/postgres/init.sql`: two tables — `runs` (PR coordinates, started_at / finalized_at, status, aggregated cost, recommendation/summary) and `trace_events` (run_id FK, seq, ts, kind, jsonb payload). Cost columns are NUMERIC(12,6) for dollars and BIGINT for token totals. `docker-compose.yml` brings up Postgres 16 on host port 5433 so it doesn't collide with `rag-production-kit`'s 5432.
- `src/trace/store.ts` — `TraceStore` interface + `MemoryStore` for hermetic tests. `aggregateCost(events)` sums each `Observation.cost` field across the run and skips missing values rather than treating them as zero (D-005). `src/trace/pg-store.ts` is the Postgres-backed implementation; `pg` is lazy-imported and listed as `optionalDependencies` so the package loads cleanly without it.
- `Observation` extended with optional `cost?: { input_tokens, output_tokens, dollars }` in `src/agent/types.ts`. The executor doesn't synthesize it — tools and the LLM-driven planner (future) report it. The seam is enough for #7 to start measuring without further plumbing.
- `src/ui/server.ts` is the trace viewer's HTTP server — `http.createServer` + four routes (`/`, `/app.js`, `/api/runs`, `/api/runs/:run_id`). `src/ui/index.html` + `src/ui/app.js` is the React 18 UI loaded via an ESM import map pointing at `esm.sh`, with `htm` for JSX-free templating (D-006). No bundler, no npm-side React. One list screen with cost columns, one run-detail screen with a chronological timeline keyed off the event `kind`. Run with `npm run trace:server -- --memory` (seeds two sample runs) or against `DATABASE_URL`.
- 20 new tests across `test/trace/store.test.ts` (cost aggregation math, MemoryStore round-trip, status derivation, pagination, defensive copies) and `test/ui/server.test.ts` (all 4 endpoints, limit/offset clamping, 404 path). Total now 77 hermetic + 4 pg-integration (skipped without `DATABASE_URL`). CI gets a new `pg-integration` job that brings up a Postgres service container, applies `init.sql`, and runs the marked tests.
- `docs/architecture.md` mermaid relabels the trace box "Trace store (issue #6 — shipped)" with the React-via-CDN viewer; new "Trace persistence + viewer" subsection. Pending downstream shrinks to just #7. Smoke-tested the viewer locally: `npm run trace:server -- --memory` boots, `/api/runs` returns the two seeded rows with cost, `/api/runs/sample-finalized` returns the full event log.
- Two decisions: D-005 (finalize-time persistence + skip-missing-cost semantics) and D-006 (React via ESM CDN + `htm`, no bundler).

**Why this work, this session:** #6 was the last "agent-core-plus-persistence" piece before #7 can land — the eval suite needs a place to read runs from, and the cost-aggregation contract needs to exist before any planner that emits cost can be evaluated. With the Trace shape from #3 already mirroring the persistence schema, this session was 70% serialization and 30% UI.

**Open questions / blockers:** None. The viewer renders against a memory-seeded sample on local boot; against a real PG it'll show whatever runs persist. The "minimal React UI" requirement is interpreted as React-the-library-running-in-the-browser, not React-the-build-toolchain — D-006 spells out why.

**Next session:** #7 (eval suite, the last open priority:high on this repo). The `Review` shape it'll score against is now persisted and aggregatable, so the eval delta becomes a real number rather than a forward-reference.
