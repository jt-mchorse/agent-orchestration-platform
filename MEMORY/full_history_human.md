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

## 2026-05-16 — Issue #7: Agent eval suite
**Duration:** ~50 min · **Branch:** `session/2026-05-16-0445-issue-7`

- Shipped the agent eval suite in `src/eval/` across three modules: `score.ts` (scoring math), `runner.ts` (agent + golden discovery + aggregation), `comment.ts` (sticky-PR-comment renderer + upsert via stdlib-only urllib equivalent in node).
- Hand-labeled golden reviews committed under `fixtures/sample-prs/*.golden.json` for the two existing fixture PRs: rag-production-kit#9 (approve_with_comments, 3 findings centered on chunk-id collisions + per-method-ranks coverage + RRF provenance praise) and vector-search-at-scale#6 (request_changes, 3 findings centered on IAM scope + open security group + missing cost disclosure).
- `scoreReview(actual, golden)` returns three sub-metrics: exact-class recommendation match (0/1), findings F1 against a severity-keyed greedy 1:1 fuzzy match (D-011, Jaccard threshold 0.30), and a summary length-ratio. Composite is `0.5 × recommendation + 0.4 × findings_f1 + 0.1 × summary_length` — weights reflect the relative stakes (getting the recommendation right is what a human reviewer would actually use).
- `evaluateAll(cases)` runs the agent against each fixture using the existing `AgentRun` from #3 with a `ScriptedPlanner` placeholder (the heuristic `_buildScriptedReview` produces a deliberately-mediocre review so the eval has something to score; once `AnthropicPlanner` lands it swaps in cleanly). The CI run reports the placeholder's baseline numbers: composite 0.345, 50% recommendation accuracy, 0 findings F1 (the scripted agent doesn't emit findings).
- `.github/workflows/eval.yml` runs on `pull_request`, dry-runs the eval to log preview, then upserts the sticky PR comment. Uses hidden HTML marker `<!-- agent-eval:sticky-comment -->` (D-010, distinct from llm-eval-harness's marker so consumers running both don't collide).
- 33 new tests across `test/eval/{score,runner,comment}.test.ts`: jaccard math, finding-matching semantics (severity gate, threshold, 1:1 greedy), scoreReview composite weighting, edge cases (empty summary, no findings), the agent runner against the real committed fixtures, the comment markdown shape + sticky-comment plumbing against an in-process FakeGithub. Suite total: 110/110 pass + 4 skipped (the existing pg-integration tests); typecheck clean.
- D-010 (TS-only, no python eval-harness pip install in CI) and D-011 (greedy 1:1 severity-keyed matching) recorded.

**Why this work, this session:** #7 was the last open priority:high in agent-orchestration-platform. With the eval suite shipped, the repo hits v0.1: README + arch + quickstart + working agent loop + trace observability + eval suite + MEMORY + MIT.

**Open questions / blockers:** None. Real LLM-driven reviews (and thus higher composite scores) come from `AnthropicPlanner` landing — the seam is the `Planner` interface from #3.

**Next session:** All priority:high closed across most repos in this multi-issue session. Either start polishing or move to one of the remaining repos with a high open.


## 2026-05-17 — Issue #5: Per-tool retry and one-hop fallback
**Duration:** ~50 min · **Branch:** `session/2026-05-17-1915-issue-05`

- Extended `ToolAnnotations` with two optional fields: `retry: RetryPolicy` (`maxAttempts`, `backoffMs`, `backoffMultiplier` defaulting to 2.0, `retryableErrorKinds` defaulting to `["internal"]`) and `fallbackTo: string` (D-012). Validation and approval ToolError kinds are never retried by default — they're deterministic per input, so a second attempt with the same payload is guaranteed to fail.
- New module `src/agent/retry.ts` with a pure `withRetry(fn, policy, onAttempt, sleep)` helper. It knows nothing about the trace, the registry, or the planner; the executor wires `onAttempt` to emit `retry_attempted` events and forwards a pluggable `sleep` so tests run synchronously with a recorded-no-op clock.
- New executor method `runStepWithRetryAndFallback(step)` orchestrates the three recovery layers in order: retry on the primary → one-hop fallback (the primary's `annotations.fallbackTo`) → planner replan (existing). The planner sees **exactly one observation per step** regardless of how many retries or fallbacks fired — recovery details live in the trace, not in the planner's input.
- New trace event variants `retry_attempted` (`toolName`, `attempt`, `backoffMs`, `error`) and `fallback_used` (`from`, `to`, `error`). The `ReplanReason.toolName` now uses `error.toolName` rather than `step.tool`, so a replan triggered by a fallback's failure reports the fallback's name — more honest, and the existing replan tests still pass because primary == fallback name when no fallback fired.
- Fallback graph hygiene: only one hop is followed. The fallback's own `fallbackTo` is ignored, making cycles impossible by construction. A `fallbackTo` pointing at an unregistered tool surfaces as an `internal` ToolError observation (the orphan name appears in the message) rather than crashing the run.
- 15 new tests: 9 unit in `test/agent/retry.test.ts` (happy-path-no-sleep, transient-then-success, configurable multiplier, non-ToolError-not-retried, validation-kinds-not-retried-by-default, custom retryable kind, exhaustion-surfaces-final-error, `maxAttempts=0`-clamps-to-1, defaults sanity-check) + 6 integration in `test/agent/executor.test.ts` (retry-then-success, retry-exhausted-then-fallback, only-one-observation-when-both-fire, both-exhausted-triggers-replan-with-fallback-tool-name, missing-fallback-target-surfaces-as-observation, single-hop-not-chain). Suite total: 125/125 pass + 4 skipped. Typecheck clean.
- README adds a "Retry and fallback (#5)" subsection under HITL with a 10-line example. `docs/architecture.md` adds a "Recovery layers (this PR — issue #5)" subsection with the layered-text diagram, event listing, and the one-hop + misconfig-surfacing semantics spelled out.

**Why this work, this session:** Issue #5 was the only remaining `priority:med` open on this repo and brings the recovery story to parity with the existing replan layer. The data-with-the-tool placement (D-012) is consistent with how destructive annotations + retry policy live alongside each other on the tool definition — a registry consumer sees the full operational policy in `registry.list()` without consulting an external map. The "one observation per step" invariant matters because the planner's mental model is per-step; if retries surfaced as separate observations, every planner would have to learn to ignore them.

**Open questions / blockers:** None on this issue. Per-run dynamic retry policy override (executor-side knob) is deferred — the annotation-only path covers the acceptance criteria and a follow-up issue can land it cleanly if a real workload needs it. Exponential backoff with jitter is similarly a knob, not a capability gap, and the deterministic schedule keeps tests readable.

**Next session:** The repo now has no `priority:high` and no `priority:med` open. Either move on to the next 36h+-untouched repo (`nextjs-streaming-ai-patterns`), or file polishing issues (e.g., the `AnthropicPlanner` swap-in that #3's exit context flags, or a follow-up `bench_recovery.py` that demonstrates the trace events under a realistic flaky-tool workload).

## 2026-05-18 — Issue #15: README truth pass — real eval numbers published

**Duration:** ~30 min · **Branch:** `session/2026-05-18-2318-issue-15`

- Repaired README drift. All seven feature issues are closed, but Quickstart, Benchmarks/Results, and Demo sections all framed substantial work as "pending #N" with #N already closed. Rewrote each: Quickstart now covers all three runnable surfaces (registry, `npm run eval -- --dry-run`, `npm run trace:server`); Benchmarks/Results publishes the real composite (0.345), recommendation accuracy (50%), and findings F1 (0.000) from the scripted planner against the two hand-labeled fixtures, with honest disclosure that the composite is deliberately low because the current planner is a baseline; Demo describes today's state and tracks the captured GIF/video as low-priority follow-up #16.
- Added `scripts/render-eval-snapshot.ts` (calls `renderEvalMarkdown(evaluateAll(discoverCases(...)))` and writes `docs/eval_snapshot.md` — no npm header, no per-run timestamp) and committed the resulting `docs/eval_snapshot.md` as the source of truth. `test/readme-snapshot.test.ts` (11 tests) locks three layers: the committed snapshot byte-matches the live renderer; the README's composite / accuracy / F1 / per-fixture rows match the renderer's numbers; every `npm run <name>` and bare `npm <verb>` in the README maps to a real script in `package.json`. Verified the failure path by tampering the snapshot's composite — test fired with regen hint, regenerating restored.
- 125 → 136 tests. `npm test`, `npm run typecheck`, `npm run build` all clean. Same hygiene pattern as today's sister-repo snapshot PRs (`llm-cost-optimizer`, `prompt-regression-suite`, `rag-production-kit`, `nextjs-streaming-ai-patterns`).

**Why this work, this session:** Two of three "pending" sections in the README pointed at issues that closed weeks ago. With a deterministic scripted planner already producing real numbers via `npm run eval -- --dry-run`, the right move was to publish them (with honest disclosure of the baseline state) and lock the table to the renderer so the next planner upgrade can't silently desync the docs.

**Open questions / blockers:** Real (LLM-backed) planner numbers are still operator action (requires `ANTHROPIC_API_KEY`); scripted planner numbers are the published baseline. Captured 60s GIF/video remains unbuilt — owned by #16.

**Next session:** All open issues except the new low-priority demo capture (#16) are closed. Substantive feature work for this repo is done.

## 2026-05-20 — Issue #18: lock src/index.ts public surface (TS variant)
**Duration:** ~30 min · **Branch:** `session/2026-05-20-0342-issue-18`

- Added `test/public-surface.test.ts` (vitest, 4 test definitions, 6 test items after `it.each` expansion). First TypeScript translation of the portfolio-wide public-surface hygiene pattern (eight Python predecessors). Four axes adapted from the Python `tests/test_public_surface.py` template: `package.json#version` semver (TS analog of `__version__`); `Object.keys(import * as Index)` defined-and-non-null (analog of `__all__`); README's three quoted import names resolve (`buildDefaultRegistry`, `createCliApprovalProvider`, `autoApproveProvider`); `package.json#bin.portfolio-context-mcp` maps via tsconfig `rootDir`/`outDir` back to `mcp-server/portfolio-context/bin.ts` as the pre-build source-of-truth (CI's test job doesn't run `tsc` first, so verifying `dist/` would need a build step).
- Type-only exports (`export type { ... }`) are intentionally out of scope — they don't exist at runtime, so `Object.keys` can't see them; future iteration if drift in type exports proves to be a real failure mode.
- Tamper-verified three axes: bad `package.json#version`, rename `export function buildDefaultRegistry` so it's no longer exported, bad bin target. All fire with the regen hint and the dropped name.
- Full suite 142/142 (was 136; +6 new). `npm run typecheck` clean.

**Why this work, this session:** Tenth strike of the portfolio-wide public-surface hygiene pattern, but the FIRST TypeScript one. Sets the template the remaining two pure-TS repos (`nextjs-streaming-ai-patterns`, `ai-app-integration-tests`) can copy.

**Open questions / blockers:** None — PR ready for review.

**Next session:** Apply the same TS template to `nextjs-streaming-ai-patterns` and `ai-app-integration-tests`. Both are pure-TS portfolio repos with public-surface entry points that haven't been locked yet.

## 2026-05-21 — Issue #16: 60-second demo capture script
**Duration:** ~25 min · **Branch:** `session/2026-05-21-1940-issue-16` · **PR:** #20

- Added `scripts/capture_demo.sh` driving the two surfaces from the README's Demo section: `npm run eval -- --dry-run` (prints the rendered sticky-comment markdown + composite/per-fixture table; fixtures committed under `fixtures/sample-prs/` so hermetic), then `npm run trace:server -- --memory` spawned in the background, `curl /api/runs` to show the two seeded synthetic runs (sample-finalized, sample-aborted) the React UI consumes, then SIGTERM via EXIT trap so the demo can't leave a port-holder behind. Port-poll loop (250ms × 25 attempts) before curl so slower CI machines don't race.
- Added `test/capture-demo-smoke.test.ts` (vitest, 4 tests) that spawns the script with `PACE=0` and asserts: exit 0; the `<!-- agent-eval:sticky-comment -->` marker is present (load-bearing for the GH Action's in-place comment edit); the composite + per-fixture table headers are present; both seeded runs appear in the /api/runs JSON; the response envelope shape (`runs`/`limit`/`offset`) the React UI binds against is locked from the capture path too; script exists and is executable.
- Deliberate design choice documented inline in the script: the browser tour stays *out* of the script. Driving a browser would need Playwright/Puppeteer (heavy new dep). The /api/runs JSON is what the React UI consumes; curl-then-assert gives the same protection from a different angle. JT records the browser portion separately during the trace-server section of the recording.
- README "Demo" section: "**pending**" line replaced with the real invocation, the PgStore-vs-MemoryStore distinction, and a pointer to the smoke test as the bitrot guard. 146/146 tests pass, `tsc --noEmit` clean.

**Why this work, this session:** Ninth repo to land the `scripts/capture_demo.sh` pattern this week, and the first TypeScript-flavored one in the run. Issue #16 was the explicit owner of the README's pending demo claim and was sitting at `priority:low` — closing it cleanly closes the last quality-bar gap in this repo's v0.1 story.

**Open questions / blockers:** None. The browser tour is JT's separate recording step; the script's epilogue tells the operator how to open the UI manually for that purpose.

**Next session:** Continue the multi-issue loop if time. nextjs-streaming-ai-patterns #12 is the next stale repo in §8 build order.

## 2026-05-22 — Rename `unsupported_in_replay` → `unsupported_in_live` (#21)

**Duration:** ~30 min. **Issue:** [#21](https://github.com/jt-mchorse/agent-orchestration-platform/issues/21). **PR:** TBD.

`ToolErrorKind` carried a literal called `unsupported_in_replay`. Reading the five throw sites (`fetch-pr`, `read-file-at-ref`, `run-check`, `search-repo`, `post-review-comment`), every one of them threw the kind when `ctx.mode === "live"` — i.e. the opposite of what the name said. The retry helper's docstring further reinforced the mislabel by calling the kind "a fixture gap, not a transient failure" — fixture gaps are actually surfaced via `not_found`, not via the misnamed kind. Caller code that branches on `ToolError.kind` was reading a label that pointed the wrong way.

Renamed the literal to `unsupported_in_live` and updated the seven touch points (the type, five throw sites, retry.ts docstring, agent/types.ts docstring, and `docs/architecture.md`'s replan-trigger taxonomy). Regenerated `dist/` via `npm run build`. Retry semantics unchanged — the kind was non-retryable by default before (only `internal` is default-retryable), and it's still non-retryable now; only the label moved.

Two lock tests ship alongside, in different layers: `test/tools/live-mode-error-kind.test.ts` calls every tool with a live-mode stub and pins `error.kind === "unsupported_in_live"` at the runtime layer (`post_review_comment` routes through `autoApproveProvider` so the destructive gate clears before the stub fires); `test/tools/error-kind-source-snapshot.test.ts` reads `src/tools/types.ts`, `src/agent/retry.ts`, and `docs/architecture.md` and asserts the new name is present and the legacy name is gone, so a future copy-paste can't reintroduce the misnamed literal even if no test happens to exercise a live-mode path. That's the same belt-and-braces pattern this portfolio's other read-snapshot tests use.

Why prioritized: this is the fifth post-v0.1 silent-drift fix landing tonight (after `embedding-model-shootout` #17, `chunking-strategies-lab` #19, `vector-search-at-scale` #19, `python-async-llm-pipelines` #21). All five are different shapes of the same family — labels/docs/contracts that drift from code behavior. Closing them as a batch braces the portfolio against handoff §10's longest rule ("do not invent benchmark numbers" generalizes to "do not let labels lie about what they label"). Open questions / followups: actually wiring live mode for any tool is a separate scope; #3's planner GitHub-client seam is where that work would land. The kind rename doesn't unblock or block that — both directions remain reachable.

## 2026-05-23 — Architecture-doc steady-state rewrite + lock (#23)

**Duration:** ~40 min. **Issue:** [#23](https://github.com/jt-mchorse/agent-orchestration-platform/issues/23). **PR:** [#24](https://github.com/jt-mchorse/agent-orchestration-platform/pull/24).

This was the **only repo with real drift** in the night's five-sister-issue sweep. The doc was committed alongside the substrate PR (issue #1) and never reframed; six section headers + two paragraphs carried pre-shipping `this PR — issue #N` / `deliberately not in this PR` framing for surfaces that had since shipped.

Rewrote each: per-layer headers are now `## <Layer> (#N)`; the empty "Pending downstream" section is gone; the `AnthropicPlanner` framing is restated as the *operator-driven* posture it actually is (same shape as the live-API integration tests in `llm-cost-optimizer` and `llm-eval-harness`); the TS-scaffolding framing is restated as a fact about what's in the tree today.

Also added D-003 (`Planner` three-method interface) and D-004 (replan budget default = 5) bullets to the §Agent loop "Why these decisions" list — both decisions were active per `MEMORY/core_decisions_ai.md` but the doc never cited them.

Vitest lock with 12 tests, four invariants pinned, tamper-verified each. TypeScript-side needed `undefined` guards on regex captures for strict-null typecheck.

**Why this work, this session:** Final of five sister issues in the night sweep. **Open questions / blockers:** none. **Next session:** portfolio-wide architecture-doc lock pattern now has 12-of-12 coverage; sweep complete.

## 2026-05-24 — Issue #25: RetryPolicy backoffMaxMs cap + full-jitter option

**Duration:** ~25 min. **Issue:** [#25](https://github.com/jt-mchorse/agent-orchestration-platform/issues/25). **Branch:** `session/2026-05-24-0403-issue-25`.

`withRetry` computed backoff as `backoffMs * mult^(n-1)` with no cap and no jitter. Two production-realism gaps: high multiplier or high `maxAttempts` let the per-attempt sleep grow unbounded (binary exponential at 10 attempts → ~100s on the 10th), and every concurrent agent slept exactly the same time, producing a synchronized thundering herd against the downstream service on every shared failure.

Added two optional fields to `RetryPolicy`: `backoffMaxMs?: number` clamps the per-attempt sleep at this value after the exponential compute (undefined keeps unbounded growth — byte-identical to today), and `jitter?: "none" | "full"` (default `"none"`) implements the AWS-SDK / Google-SRE-book "full jitter" pattern: `sleep ← random.uniform(0, capped_backoff)`. A new `RandomFn` injection seam (parallel to the existing `SleepFn` seam) lets tests pin jitter for deterministic assertions.

The `RetryAttempt.backoffMs` reported through the `onAttempt` callback is now the actually-slept value — after both cap and jitter — instead of the abstract formula. That matters because the trace event derived from that callback should reflect reality, not what would have been slept under different settings.

Six new tests pin the contract: cap clamps a runaway compute (`backoffMs=100, mult=4, max=500` → slept sequence `[100, 400, 500, 500]`); undefined cap preserves unbounded growth; full jitter with a pinned random sequence draws sleeps in `[0, capped]`; no-options is byte-identical regression guard; the `onAttempt` callback's `backoffMs` matches the actually-slept value (after cap + jitter); cap holds even when jitter factor = 1.0.

**Why this work, this session:** Ninth issue in the night-session multi-issue loop. Second safety gap fix (after `python-async-llm-pipelines` #26 added per-tool timeout). The pattern this session keeps surfacing: every repo had at least one CLI parity or library-safety gap that read cleanly from the source.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue to build-sequence #10 (`mcp-server-cookbook`).

## 2026-05-24 — Issue #27: `registry.list()` surfaces `destructiveReason`

**Duration:** ~15 min. **Issue:** [#27](https://github.com/jt-mchorse/agent-orchestration-platform/issues/27). **Branch:** `session/2026-05-24-1541-issue-27`.

`src/tools/types.ts` line 46-47 already documents the intent: `registry.list()` is the self-describing surface, configured this way so policy can't silently drift from tool changes (the same reason D-012 places `retry` on the annotation rather than on an executor-side side-table). But the implementation only returned `{name, description, destructive}` — `destructiveReason`, which `register()` enforces non-null for destructive tools, was hidden behind a `get(name)` round-trip. Callers wanting an "all destructive tools and their effect" view (the approval UI's natural surface, or an MCP-style `list_tools` projection) had to crawl annotations themselves.

Same shape of half-implemented capability as today's `mcp-server-cookbook` #31 — the rich data was populated, the public projection just didn't expose it. The fix is additive: `list()` now returns `{name, description, destructive, destructiveReason: string | null}`. Destructive tools render the registered reason (non-null by register-time guarantee at registry.ts:11-14); non-destructive tools render `null` rather than the invoke-path's `"tool is marked destructive"` fallback, since `list()` describes the tool's intent, not how the invoke path handles missing reasons.

The existing "registers, lists, and invokes tools" test had to be updated to include the new `destructiveReason: null` field on the echo tool — that assertion was the regression-pin for the list shape, and the additive change shifts it by one key. Three new tests cover (a) a destructive tool surfaces its reason, (b) a non-destructive tool surfaces null, (c) a multi-tool registry distinguishes the two correctly.

**Why this work, this session:** Sixth Phase B+C target of a 180-min day session. Same shape of fix as `mcp-server-cookbook` #31 — the data was always there; the public surface just had to forward it. Each repo in today's session has shown the same pattern in its own form: a previous PR shipped the capability one layer down, and the polish PR brings it out to where consumers actually see it.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue the day-session loop if time permits. Remaining candidates: TS frontends (`nextjs-streaming-ai-patterns`, `ai-app-integration-tests`) which haven't been touched today, or `vector-search-at-scale` / `rag-production-kit` / `chunking-strategies-lab` for analogous polish gaps.

## 2026-05-25 — Issue #29: withRetry validates RetryPolicy at entry; no more silent clamp
**Duration:** ~30 min · **Branch:** `session/2026-05-24-issue-29`

- `withRetry` at `src/agent/retry.ts:79` did `Math.max(1, policy.maxAttempts)` and accepted everything else (`backoffMs`, `backoffMaxMs`, `backoffMultiplier`) without validation. Three concrete failure modes were silently absorbed: `maxAttempts = 0` reversed the operator's intent (became 1); `maxAttempts = NaN` made the loop never execute and threw `undefined`; `backoffMs < 0` was spec-coerced to `0` by `setTimeout`. `backoffMultiplier < 1.0` produced shrinking-not-growing schedules that contradict the docstring's `1.0 = fixed-interval retry`.
- Added `validatePolicy(policy)` at the entry of `withRetry` — runs before any attempt is made. Each invalid field throws `RangeError` naming the field and value. The old `Math.max(1, ...)` clamp is removed (dead code after validation). The validations match each field's documented contract: `maxAttempts` integer `>= 1`, `backoffMs` finite `>= 0`, `backoffMaxMs` (if defined) finite `>= 0`, `backoffMultiplier` (if defined) finite `>= 1.0`.
- 15 new tests in `test/agent/retry.test.ts` under an issue-#29 `describe` block, organized as `it.each` tables for per-field rejection (`0`, `-1`, `NaN`, `+Infinity`, fractional where relevant) plus boundary acceptance (`1`, `0`, `0`, `1.0`). One test pins "validation runs before `fn()` is invoked even once" so the contract is anchored at the entry rather than drifting inside the loop. The pre-existing `clamps maxAttempts < 1 to a single attempt` test is retired with a comment pointing to the new block. Net +13 tests (15 added, 1 retired, 1 not applicable in this counting). Full suite 198/198 + 4 skipped (was 175 after #27).

**Why this work, this session:** Second Phase B+C target in the 360-min night session. First TypeScript repo to join the contract-tightening sweep that has now landed in 8 Python repos. The TS analogue of Python's `__post_init__` pattern is "validate at function entry, throw `RangeError`" — same posture (no silent degeneracy from operator-supplied numerics), idiomatic surface.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue the loop. `mcp-server-cookbook` (build seq #10) is the next TypeScript target; after that `nextjs-streaming-ai-patterns` (#11) and `ai-app-integration-tests` (#12) close out the unvisited-tonight repos.

## 2026-05-26 — Issue #31: ExecutorOptions validation completes the #29 sweep into AgentRun
**Duration:** ~25 min · **Branch:** `session/2026-05-25-2350-issue-31`

- `AgentRun.run()` previously consumed `this.opts.maxReplans ?? DEFAULT_MAX_REPLANS` without any validation, while the sibling `withRetry` flow had `validatePolicy` at entry (#29). Added a `validateOptions(opts)` helper at the bottom of `src/agent/executor.ts` mirroring `validatePolicy` (same file: `retry.ts:88-113`). `AgentRun.run()` calls it before reading `maxReplans`, so misconfig fails loud before any planner / tool / trace activity.
- Closed five silent failure modes — most importantly: `maxReplans=NaN` made `replans >= NaN` always false, so the budget-exhaust abort branch was unreachable. Re-plans looped indefinitely with no `aborted` trace event ever firing. Bool / float / negative / Infinity all produced misleading aborts (`"max_replans_exceeded:<bad>"`) or silently disabled the budget contract.
- 17 new collected test cases in a new "ExecutorOptions validation (#31)" describe block: 11-value `it.each` rejection matrix, 5-value acceptance pin over `[1, 2, 5, 10, 100]`, default-preservation pin (covers both omitted-opts and explicit-empty-opts paths), an ordering pin that asserts `plannerCalls === 0` and `trace.events()` empty after a rejected construct (proving validation fires *before* any other activity), and a RangeError-message-shape regex pin on the field name and value. Full suite 217 passed + 4 pre-existing skipped. Typecheck clean.

**Why this work, this session:** Sixth Phase B+C target in the 360-min night session and the first TypeScript Phase B+C PR of this session (prior five were Python). Picked via build-sequence #9 after `python-async-llm-pipelines#35` (#5). `AgentRun.run` is the sibling entry point to `withRetry`; #29 only tightened the retry side, leaving the executor side as the natural symmetric gap.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue the loop. `mcp-server-cookbook` (build #10, TypeScript) is the natural next pickup — same TypeScript validation patterns apply. After that, `nextjs-streaming-ai-patterns` (#11) and `ai-app-integration-tests` (#12).

## 2026-05-26 — Issue #33: Atomic writes — TypeScript parallel of the morning Python arc
**Duration:** ~25 min · **Branch:** `session/2026-05-26-1940-issue-33`

- Two production write sites in this repo (`src/bin/eval-runner.ts:72` for the eval-result JSON; `scripts/render-eval-snapshot.ts:25` for `docs/eval_snapshot.md`) were using `fs.writeFile`. Like Python's `Path.write_text`, that opens the destination with `O_TRUNC` — the bytes only commit on `close()`, so a signal between the open and the close leaves the destination zero-length or partial. The harm shapes are familiar: the eval-result JSON feeds downstream sticky-comment renderers and CI artifacts, and `docs/eval_snapshot.md` is what the README's "Evaluation snapshot" section renders from on GitHub.
- New helper at `src/io/atomic-write.ts:atomicWriteFile(target, data, encoding="utf-8")`, mirroring `servers/filesystem-sandbox/src/atomic_write.ts` from `mcp-server-cookbook#37` — the TypeScript portfolio leader. Both call sites refactored to use it. The eval-runner refactor also dropped the inline `fs.mkdir(resultsDir, ...)` because the helper's own `mkdir` covers parent-directory creation.
- Tests: `test/io/atomic-write.test.ts` adds 6 unit tests on the helper (happy path, parent-dir create, overwrite, three load-bearing failure invariants — destination-absent on rename failure for new files, no leftover `.tmp` siblings, pre-existing-file-unchanged on overwrite failure) plus 2 integration tests: one direct call-shape exercise for the snapshot write, and one static-source assertion that `src/bin/eval-runner.ts` imports `atomicWriteFile` and calls it (no residual `fs.writeFile`). The static-source-assertion shape comes from the portfolio's existing architecture-doc-lock and readme-lock tests; it pins call-site routing without depending on the script's runtime importability (the script's `main()` auto-invokes at module load, so re-importing for monkey-patching would race with real execution).
- D-013 codifies the package-level `src/io/` placement, matching the TypeScript portfolio standard. Full suite 221 → 229, typecheck green.

**Why this work, this session:** Third Phase B target of today's 180-min DAY session. Previous two issues (llm-eval-harness#50 promotion, embedding-model-shootout#37 first-time landing) extended the atomic-write arc in Python. This one extends the same arc in TypeScript by closing the remaining `fs.writeFile` calls in this repo. Portfolio atomic-write coverage now sits at 8 of 12 repos (six morning arc + llm-eval-harness promotion + embedding-model-shootout + this one). Four candidates remain to scan: `nextjs-streaming-ai-patterns`, `python-async-llm-pipelines`, `chunking-strategies-lab`, `vector-search-at-scale`.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Scan the remaining four repos for `Path.write_text` / `fs.writeFile` production write sites. If any have gaps, file an issue and ship a fix the same shape. If all are clean (some may just have no on-disk artifact surface — `python-async-llm-pipelines` is a benchmark-runner, may have none), the portfolio-wide atomic-write arc is genuinely saturated and the next session can pivot to a different harm class (input-trust on external API responses, resource leaks on error paths, or test-determinism guarantees).

## 2026-05-26 — Issue #35: README decision-range upper-bound lock
**Duration:** ~8 min · **Branch:** `session/2026-05-26-2334-issue-35`

- Added `test/readme-decision-range.test.ts` — first TypeScript translation of the Python lock pattern.
- Added `D-002…D-013` citation under `## Architecture`.

**Why this work, this session:** Propagation 8 of 10 of the cross-portfolio drift class. First TS propagation, sets the template for `mcp-server-cookbook`, `nextjs-streaming-ai-patterns`, and `ai-app-integration-tests`.

**Open questions / blockers:** none.
**Next session:** Continue to mcp-server-cookbook.

## 2026-05-27 — Issue #37: CONTRIBUTING.md cadence-wording propagation
**Duration:** ~3 min · **PR:** #38

- Replaced pre-D-008 `~60-minute session cap` line with D-008 (180/360 min, multi-issue loop) and D-004 (Phase A PR auto-merge) wording, matching the bootstrap template post-portfolio-ops#3.

**Why this work, this session:** Iteration in the autonomous NIGHT session propagation arc for portfolio-ops#3.

**Open questions / blockers:** none.

**Next session:** continue portfolio propagation.

## 2026-06-01 — Issue #39: First TypeScript port of the validate pattern
**Duration:** ~22 min · **Branch:** `session/2026-06-01-2335-issue-39`

- Shipped `src/eval/validate.ts` with `validateFixture(path)` and `validateGolden(path)`, walking the JSON in collecting mode and returning a frozen `ValidationReport` with eighteen fixture finding codes and eleven golden finding codes. Full coverage of `fixtures/sample-prs/SCHEMA.md` including `repo_format`, `files_empty`, per-field `pr.*` and `files[*].*` checks, and `patch === null` accepted for binary/large files.
- Shape divergence from the four Python sister ports: `jsonPath` replaces `lineNo` because inputs here are single JSON documents, not JSONL. A dotted path like `pr.number` or `files[0].filename` is what the operator actually needs to locate the problem. Small reasoned divergence, no D-NNN.
- TypeScript strict mode (`exactOptionalPropertyTypes: true`) required conditional spreads when the report's `schemaVersion`/`recommendation` scalars are absent — kept the report's published surface tight without leaking `undefined` into JSON consumers.
- Wired `npm run validate -- <path> [--golden] [--json]` (`src/bin/validate.ts`). Exit codes 0/1/2 uniform with the Python sister validators so consumers can chain validators across the language boundary.
- `test/eval/validate.test.ts` is 29 cases — both shipped fixture/golden pairs validate clean, accumulating-multi-finding (no fail-fast), one positive per major finding code, frozen shape, renderer round-trip, and five CLI end-to-end cases via `npx tsx` subprocess.
- `docs/architecture.md` Eval suite section now enumerates four modules (validate is the fourth, annotated with #39 and cross-referenced to the four sister-repo PRs). README "Quickstart" gains a `npm run validate` block. `test/architecture-doc.test.ts` `KNOWN_SHIPPED_ISSUES` and its hard-pin extended to include #39.
- Live-tested against both shipped fixture/golden pairs: exit 0 in one pass with `schema_version=1` / `recommendation=approve_with_comments`. Full suite 255 / 255 pass (4 skipped, existing pattern), typecheck clean.

**Why this work, this session:** Fourth iteration of the day-session loop. The validate pattern had propagated to four Python repos this week, and the fail-fast `JSON.parse` shape at `src/eval/runner.ts` L50-51 and L125-126 was the most natural TypeScript port target — `fixtures/sample-prs/SCHEMA.md` is a rich spec that maps 1:1 to a collecting-mode lint. Crossing the language boundary is its own form of pattern validation.

**Open questions / blockers:** None — ready for review.

**Next session:** Continue the day-session loop. Remaining untouched-since-2026-05-27 candidates: `mcp-server-cookbook` (next in TS build sequence; check for similar fixture-validation gaps), `nextjs-streaming-ai-patterns`, `ai-app-integration-tests`. `vector-search-at-scale` has no obvious validate analog (single-JSON results files, no JSONL).

## 2026-06-17 — Issue #41: Workflow YAML-parseability lock (TS port)
**Duration:** ~18 min · **Branch:** `session/2026-06-17-1916-issue-41`

Added `test/workflows-yaml-parseable.test.ts` (vitest), pulling
`js-yaml@^4.2.0` and `@types/js-yaml@^4.0.9` into `devDependencies`.
The test enumerates `.github/workflows/*.yml` at module scope and
registers two `it` blocks per file (parse + non-empty `jobs:`) plus
one smoke check that ≥1 file exists. 5 tests today across `ci.yml`
and `eval.yml`.

**Why this work, this session:** First TypeScript hop of the
`portfolio-ops#30` propagation arc — same inverse safety net that
closed the 21-day silent CI outage in `portfolio-ops#27`. Three
Python sisters already shipped (`llm-eval-harness#61`,
`rag-production-kit#53`, `chunking-strategies-lab#40`); this is the
TS port and the pattern that the remaining TS repo
(`mcp-server-cookbook`) will follow.

**Open questions / blockers:** none — `npm run typecheck` clean,
`npm test` 255 → 260 passed locally; PR #42 open and waiting for CI.

**Next session:** continue propagation to the remaining 8 repos.

## 2026-06-18 — Issue #43: timeout-minutes guard + lock test
**Duration:** ~15 min · **Branch:** `session/2026-06-18-0331-issue-43`

- Added `timeout-minutes` to every job in `ci.yml` (15 / 15 / 20 / 15) and `eval.yml` (15).
- Added `test/workflows-timeout-minutes.test.ts` — 16 new tests (1 smoke + 5 jobs × 3 invariants).

**Why this work, this session:** eighth hop in the portfolio-wide timeout-minutes propagation arc; second TypeScript hop after `nextjs-streaming-ai-patterns#37`.

**Open questions / blockers:** none.

**Next session:** continue propagation. Three repos remain: mcp-server-cookbook (TS), ai-app-integration-tests (TS), portfolio-ops itself.

## 2026-06-18 — Issue #45: concurrency guard + lock test
**Duration:** ~12 min · **Branch:** `session/2026-06-18-1533-issue-45`

- Added top-level `concurrency:` to `ci.yml` and `eval.yml` (distinct
  groups so they don't cancel each other on the same ref).
- Wrote `test/workflows-concurrency.test.ts` — vitest + js-yaml,
  modeled on the nextjs-streaming-ai-patterns template (#38).

**Why this work, this session:** tenth per-repo hop in the
concurrency-lock arc; second TypeScript hop. Audit fingerprint shipped
in portfolio-ops #41 surfaces every workflow missing the lock.

**Open questions / blockers:** none. Vitest 283 → 287.

**Next session:** continue propagation to remaining 2 repos
(mcp-server-cookbook + portfolio-ops itself).

## 2026-06-22 — Issue #47: eval — score matching empty findings as F1=1.0, not 0
**Duration:** ~20 min · **Branch:** `session/2026-06-22-1201-issue-47`

- Found during Phase A (Explore subagent across executor/planner/score/runner after I'd cleared retry.ts): `scoreReview` returned `findings_f1 = 0` when both the agent and golden review had zero findings — a correct "no issues on a clean PR" agreement. That penalized a perfect clean review by the full 0.4 findings weight (composite 0.6 instead of 1.0). The same file already treats the empty-empty case as 1.0 in `jaccard()` and `summary_length_ratio()`; findings F1 was the inconsistent one.
- Fix: special-case both-empty → precision/recall/F1 = 1.0. Asymmetric cases unchanged (hallucinated or missed findings still score F1 0).
- 1 new test; verified it fails on the pre-fix code. Suite 283 → 284 (4 pg-integration skipped locally), tsc clean. PR #48 ready.

**Why this work, this session:** the repo's only open work was a one-way-blocked anchor issue; this was a real, high-confidence inverted-metric bug in the eval scorer, found by reading the scoring path. Strictly higher value than a synthetic fill.

**Open questions / blockers:** none.

**Next session:** retry/executor/planner/score are well-hardened now. Remaining surface to audit if needed: `trace/pg-store.ts` event ordering and the `mcp-server/` subdir.

## 2026-06-23 — Issue #49: MCP repo-name sanitizer whitelisted backslash
**Duration:** ~15 min · **Branch:** `session/2026-06-23-0338-issue-49`

- Fixed an input-validation hole in `decisionsFilePath`. Its allow-list regex `/[^A-Za-z0-9_.\\-]/` had a literal backslash inside the character class (the `\\` was meant to escape the trailing `-`, which needs no escape), so backslash was whitelisted. A backslash-bearing repo name — e.g. a Windows-style `..\..\secret` — passed the sanitizer and flowed into `path.join`, a path-separator escape and a contract violation (the existing test rejects `/` and `../`).
- Dropped the stray backslash. Valid hyphen/dot/underscore slugs still resolve; backslash is now rejected. Added backslash-rejection and valid-slug tests. Red pre-fix, green post-fix. Suite 285 → 286, tsc clean.

**Why this work, this session:** found by the night session's Phase A dogfood wave; `decisionsFilePath` is the trust boundary for the `get_repo_core_decisions` MCP tool, whose `repo` arg is untrusted (MCP client / LLM caller). This tightens the guard to its documented contract — unambiguous, unlike the mcp-server-cookbook #54/#55 decision-revisit guards that need a human severity call.

**Open questions / blockers:** none.

**Next session:** `search-repo.ts` `truncated` reporting semantics were flagged as debatable and left out of scope.

---
## 2026-06-23 — Issue #51: search_repo falsely reported truncated at the exact-fill boundary
**Duration:** ~15 min · **Branch:** `session/2026-06-23-0420-issue-51`

- Fixed an off-by-one in `searchRepoTool`. It set `truncated: true` the instant `matches.length >= maxResults`, right after a push — even when that match was the last available. So a result set that exactly fills `maxResults` falsely claimed truncation, corrupting the signal the planner/UI use to decide whether to paginate or widen a query.
- Now collects one match past the cap (`>`, not `>=`) and slices the surplus, so `truncated` reflects real overflow. Added a robust exact-fill test. Red pre-fix, green post-fix. Suite green, tsc clean. (Confirms the lead a prior session deferred as "debatable".)

**Why this work, this session:** found by a different-angle second pass in the night session's Phase A dogfood wave; a real correctness bug on a registered planner-invokable tool's documented `truncated` contract.

**Open questions / blockers:** none.

**Next session:** none specific to search_repo.

## 2026-06-24 — Issue #53: PgStore replay left started_at stale (ON CONFLICT UPDATE omitted it)
**Duration:** ~30 min · **Branch:** `session/2026-06-23-2322-issue-53`

- `PgStore.writeRun` computed `started_at` from the input events but its `ON CONFLICT (run_id) DO UPDATE SET` clause updated every sibling field (`finalized_at`, `status`, cost/token totals, `recommendation`, `summary`) *except* `started_at`. So a replay of the same `run_id` carrying a later `run_started` ts left the persisted `started_at` stale — diverging from `MemoryStore.writeRun`, which recomputes it on every write, and drifting the `listRuns ORDER BY started_at DESC` ordering between the two stores.
- Fix: one-line addition of `started_at = EXCLUDED.started_at,` to the UPDATE clause, mirroring the sibling fields. Added a `DATABASE_URL`-gated pg-integration test that writes a run at ts=T1, replays the same `run_id` at ts=T2, and asserts `getRun().started_at` reflects T2 (parity with `MemoryStore`).
- **Verification limitation (honest):** I could not stand up local Postgres — the Docker daemon started fine, but the `postgres:16-alpine` Docker Hub pull stalled at zero bytes for >10 min (a registry/network issue on this machine), so the local autonomous run can't execute the gated test. Verified instead: `tsc --noEmit` clean, full vitest 287 passed / 5 skipped (the pg tests, now including the new one — confirming it's registered and gated). The end-to-end round-trip proof is the `pg-integration` CI job (`ci.yml`), which runs on every PR, brings up the postgres service, applies `init.sql`, and runs `npm test -- test/trace/pg-store.test.ts` with `DATABASE_URL` set. Without the fix that test asserts `started_at == T2` against an upsert that leaves it at T1, so it fails — the inverse is self-evident.

**Why this work, this session:** a real, pre-filed `priority:med` consistency bug; the two priority-tier repos worked earlier this session (`llm-eval-harness` #85, `llm-cost-optimizer` #83) were dogfood finds, and `rag-production-kit` was too hardened to surface a clean high-reachability bug quickly, so clearing a legitimate backlog item was the next-best value.

**Open questions / blockers:** none — the fix is correct by inspection (a missing upsert field) and the pg-integration CI job provides the live-Postgres execution proof on the PR.

**Next session:** a shared `MemoryStore`/`PgStore` parity harness (run both through one rewrite matrix) would lock the broader invariant; deferred as a possible follow-up.

---
## 2026-06-24 — Issue #55: fixture validator accepted negative count fields
**Duration:** ~20 min · **Branch:** `session/2026-06-24-0432-issue-55`

- `_requireFiniteInteger` checked number/finite/integer but not non-negativity, so a fixture with a negative `pr.number`/`additions`/`deletions`/`changed_files` or file-level count validated clean and flowed through `validateFixture` (the gate before `evaluateAll`) into the runner.
- Added a `value < 0` check raising a distinct `<prefix>.<field>_negative` finding, kept separate from `_wrong_type`. Matches the fail-loud entry-validation arc in retry.ts (#29) and executor.ts (#31).
- 5 new tests (negative pr.number/additions/file count, wrong_type-not-negative for a float, zero-count boundary accepted). Red via `git stash`, green after. tsc clean, vitest 287 → 292.

**Why this work, this session:** agent-orchestration-platform was the last unexamined non-tier repo this run; retry/executor/score/context/search/pg-store were saturated, so a dogfood sweep of the eval validator surfaced this.

**Open questions / blockers:** Housekeeping for JT — there's a pre-existing stray full clone of the `ai-app-integration-tests` repo nested inside the `agent-orchestration-platform` working copy (`repos/agent-orchestration-platform/ai-app-integration-tests/`, dated Jun 23 12:32, predates this session). A prior session likely ran `git clone` from the wrong CWD. It's untracked and not gitignored; left in place (not mine to delete) — recommend removing it so a future `git add -A` can't accidentally commit a nested repo.

**Next session:** planner.ts / executor.ts internals and the tools/ modules remain the dogfood frontier here.

---
## 2026-06-25 — Issue #57: skip non-finite/negative costs in aggregateCost
**Duration:** ~18 min · **Branch:** `session/2026-06-25-2353-issue-57`

- `aggregateCost` guarded each cost field with `typeof x === "number"`, but `typeof NaN === "number"` is `true` (as are `Infinity` and negatives), so a single corrupt observation made `x += NaN` poison the entire run's aggregate — which is persisted to Postgres and rendered on the run-detail screen. The guard's evident purpose was to count only real cost numbers and skip absent ones.
- Fix: an `isCountableCost` type guard (`Number.isFinite(x) && x >= 0`) skips a corrupt value the same way an absent field is skipped — a partial total, never a corrupt one. Matches the repo's finite-and-non-negative contract (`RetryPolicy.backoffMs`, the #56 negative-fixture-count guard) while keeping the aggregator's robust "skip what you can't trust" posture. Five tests (NaN/Inf/-Inf/negative per-observation + per-field drop); red-green verified (all 5 fail without the fix). Full vitest green (297 passed), `tsc --noEmit` clean.

**Why this work, this session:** fifth issue of a multi-issue DAY session. With the priority-tier and several non-tier repos already mined, a strict defensive-gap sweep of agent-orchestration-platform surfaced the cost aggregator's `typeof` hole — the one cost/number seam not yet covered by the repo's finite/non-negative hardening arc.

**Open questions / blockers:** none. (Housekeeping: the pre-existing stray nested `ai-app-integration-tests/` clone in the repo root is still present, untracked; already flagged by a prior session, left in place.)

**Next session:** the trace cost path now rejects corrupt numbers at aggregation; a follow-up could fail-loud at the cost-emission seam in the executor if upstream wants to reject corrupt costs earlier.

## 2026-06-27 — Issue #61: read-file-at-ref drops added lines starting with ++
**Duration:** ~20 min · **Branch:** `session/2026-06-27-0043-issue-61`

- `reconstructAddedFileFromPatch` skipped lines starting with `+++` or `---` to ignore unified-diff file headers. But GitHub's per-file `patch` field carries only hunk bodies (starts at `@@`) and never includes those headers — verified: 0 header-like lines across all 58 fixture patches. So the guard never fired legitimately and only misfired on a genuine added content line whose text starts with `++` (source `++flagged` → patch `+++flagged`), silently dropping it. Realistic triggers: C/Java `++i;`, markdown `++ins++`, a checked-in diff file.
- Fixed by removing the header guard (keeping the `@@` hunk-header skip) and exporting the pure helper for unit testing. 4 unit tests (++ line survives, -- line survives, normal added file, null patch). Suite 298 → 302; typecheck clean (this repo's CI has no lint/readme gate).

**Why this work, this session:** tenth issue of a multi-issue DAY run, and a deliberate **second** dogfood pass on agent-orchestration-platform. The first pass (retry/executor/planner/score) came back clean; this pass focused on the trace store and tools and found the read-file-at-ref bug — a reminder that a second pass with a different module focus surfaces what the first missed.

**Open questions / blockers:** none. Runner-up unfiled: `findStickyCommentId` stops after 10 comment pages (misses a sticky comment beyond ~1000 comments) — appears to be an intentional bound.

**Next session:** the portfolio is heavily covered — this run closed 10 issues. Future yield likely depends on new trending issues or deeper second-pass audits.

## 2026-06-27 — Issue #63: align post_review_comment enum to the canonical Review type
**Duration:** ~25 min · **Branch:** `session/2026-06-27-0344-issue-63`

- `post_review_comment`'s input schema declared the recommendation enum space-separated (`"request changes" | "approve with comments" | "approve"`), but the canonical `Review["recommendation"]` type — and the planner, eval runner/validator, trace-server, and UI CSS classes — all use underscores. Since this is the HITL tool that posts a synthesized `Review`, feeding the review's recommendation in failed zod validation for two of the three values. Reproduced: `approve_with_comments` and `request_changes` → REJECTED; only the `approve with comments` spelling nothing emits was accepted.
- Aligned the sole outlier to `["request_changes", "approve_with_comments", "approve"]`, updated the two `test/approvals.test.ts` lines that had locked the wrong contract, fixed the `docs/use-case.md` prose + a `planner.ts` doc comment, and added an `it.each` round-trip test pinning acceptance of every `Review["recommendation"]` member. `npm test` 302 → 305, tsc clean.

**Why this work, this session:** seventh issue of a multi-issue NIGHT run; a medium-high-confidence internal-contract inconsistency where the canonical `Review` type is the single source of truth and one outlier diverged.

**Open questions / blockers:** none.

**Next session:** the recommendation spelling is now uniform repo-wide; the live GitHub posting path remains un-wired (unchanged).

## 2026-06-27 — Issue #65: Postgres trace store dropped ToolError messages
**Duration:** ~25 min · **Branch:** `session/2026-06-27-1546-issue-65`

- `ToolError extends Error`, and `Error` sets `message` as a non-enumerable own property, so `JSON.stringify` omits it. `PgStore.writeRun` persists each event via `JSON.stringify(payloadOf(ev))`, so every `ToolError` on the Postgres path — error observations, retries, fallbacks, and nested `re_plan_triggered.reason.error` — round-tripped with `message === undefined`, and the run-detail UI rendered `error: <kind> — undefined`. The in-memory store was unaffected, so the two stores silently diverged on exactly the observability surface the trace store exists for.
- Added `ToolError.toJSON()` returning `{ name, kind, toolName, message }` (honored recursively by `JSON.stringify`) and hermetic round-trip regression tests. Negative-checked: all three fail pre-fix.

**Why this work, this session:** fifth find of a multi-issue DAY run, from the second Phase A dogfood sweep over the non-tier repos.

**Open questions / blockers:** none — but I noticed a stray nested clone of `ai-app-integration-tests` inside this repo's root (dated Jun 23, a misplaced clone from a prior session; clean, on main, fully pushed). Left in place and flagged for JT to remove; it risks being accidentally staged by a future `git add -A`.

**Next session:** ToolError now serializes losslessly; the PgStore/MemoryStore read-back still differs in that PgStore returns plain objects rather than reconstructed Error instances (pre-existing, out of scope).

## 2026-06-27 — Issue #67: MCP decisionsFilePath path-traversal sanitizer bypass
**Duration:** ~15 min · **Branch:** `session/2026-06-27-1941-issue-67`

- `decisionsFilePath` (the MCP portfolio-context trust boundary) strips chars outside `[A-Za-z0-9_.-]` and rejects `repo` if anything was stripped — but `.` and `-` are allow-listed, so a bare `.` or `..` survived unchanged and slipped past the check. `path.join` then collapsed the `..`, escaping the `repos/` jail (`repos/../MEMORY/...` → `<root>/MEMORY/...`). The sibling tests covered `../etc`/`a/b`/backslash forms (all contain a stripped char) but never a bare `..`.
- Fixed with a fail-closed guard rejecting `repo === '.' || repo === '..'`. Strictly more restrictive — a literal `...` directory and a `.hidden` slug still resolve. Reproduced firsthand via a throwaway vitest spec; lock test fails on pre-fix code.

**Why this work, this session:** fourth issue of a multi-issue DAY run; surfaced by a second Phase A dogfood batch after the priority tier was largely exhausted. Vector-search, chunking, embedding-shootout, python-async, and ai-app-integration-tests all came back clean — the portfolio is deeply hardened.

**Open questions / blockers:** none. Security-relevant but bounded; flagged for JT in the PR. Also noted (deferred, non-hermetic): a `MemoryStore.listRuns` vs `PgStore` collation tie-break divergence that needs a live Postgres to prove.

**Next session:** the stray untracked `ai-app-integration-tests/` nested clone at this repo's root (flagged previously) is still present — safe to remove.

## 2026-06-27 — Issue #69: denied approval silently bypassed by the fallback path
**Duration:** ~25 min · **Branch:** `session/2026-06-27-2333-issue-69`

- The executor's `fallbackTo` recovery treated `approval_denied`/`approval_missing` like an ordinary tool failure, so a denied destructive action (or one with no approvals provider wired) was silently re-run via the fallback tool — bypassing the human-in-the-loop checkpoint. Found via a Phase A dogfood sweep and independently reproduced before filing.
- Fixed by short-circuiting approval-class errors to an error observation before the fallback lookup, so the denial flows to the existing replan path (mirrors the retry layer, which already excludes those kinds). Added two locking tests.
- Suite 309 → 311, typecheck clean.

**Why this work, this session:** It was the only real, reproducible bug surfaced across 8 deep dogfood sweeps — the rest of the portfolio is saturated/hardened. A HITL bypass on destructive actions is high-value.

**Open questions / blockers:** none.

**Next session:** Portfolio is heavily saturated for autonomous bug work; remaining open issues are JT-decision (`decision-revisit`) or demo-video captures.

## 2026-06-28 — Issue #71: fixture validator accepted pr.number=0 against its own >=1 contract
**Duration:** ~20 min · **Branch:** `session/2026-06-28-0346-issue-71`

- `_requireFiniteInteger` guarded only `value < 0`, so `pr.number: 0` passed the pre-flight fixture lint despite the helper's comment stating `pr.number (>= 1)`. `fetch_pr` types `number` as `.positive()`, so a 0 fixture passed `validate` then threw at eval time — defeating the lint's whole purpose.
- Fixed by adding an optional `min` (default 0) with an `_out_of_range` branch after the existing `_negative` branch; `pr.number` validates with `min=1`. Strictly safer (only rejects input the eval already rejects); negative still yields `_negative` (#55 preserved). +3 tests; CLI repro now exits 1; full suite green.
- Found via the second Phase A dogfood wave (the other four repos — llm-cost-optimizer, embedding-model-shootout, vector-search-at-scale, python-async-llm-pipelines — came back clean/well-hardened).

**Why this work, this session:** the one solid finding from the second dogfood wave; a real contract gap on the eval pre-flight lint.

**Open questions / blockers:** none.

**Next session:** —

## 2026-06-28 — Issue #73: a malformed .json fixture crashed the whole search
**Duration:** ~20 min · **Branch:** `session/2026-06-28-1619-issue-73`

- `searchRepoTool.run` walks every `.json` in `fixturesDir` and is written to tolerate non-fixtures (`if (!parsed.success) continue`). But `JSON.parse(raw)` ran *outside* the `safeParse` guard, and `safeParse` only catches Zod mismatches — not a `SyntaxError`. So one corrupt/non-fixture `.json` in the directory threw a raw `SyntaxError` that propagated through `registry.invoke` and, not being a `ToolError`, was re-raised by the executor as a programmer bug — crashing the entire agent run on a query that wouldn't even have matched that fixture's repo.
- Fixed by decoding under `try/catch` and `continue`ing on failure, treating a JSON parse error exactly like the schema-mismatch skip two lines below. Added a vitest regression test using a temp fixtures dir (malformed + valid file) that asserts the search resolves with the valid match; proven to fail pre-fix with the SyntaxError. Full suite 315 passed (5 skipped), typecheck clean.

**Why this work, this session:** sixth substantive issue of a multi-issue DAY run and the first in a TypeScript repo (after four Python dogfood finds). A real robustness defect: a single stray file in the walked directory takes down unrelated agent runs, defeating the per-file tolerance the loop was written to provide.

**Open questions / blockers:** none.

**Next session:** continue the loop if time remains.

## 2026-06-29 — Issue #75: README trace-server port was 5180, real default is 8766
**Duration:** ~8 min · **Branch:** `session/2026-06-29-0357-readme-trace-port`

- README:80 told operators the trace viewer is at `localhost:5180`, but `npm run trace:server` binds 8766 (`trace-server.ts:121`), and `scripts/capture_demo.sh` agrees (default 8766). `5180` appeared nowhere else — an orphaned wrong value sending the quickstart to a dead port.
- README-only fix to the real default port.

**Why this work, this session:** ninth issue of the night run, from the parallel doc-contract subagent sweep (completing the prompt-regression #91 / llm-eval #118 / agent-orch #75 batch).

**Open questions / blockers:** none.

**Next session:** the trace-server quickstart URL matches the shipped default port and the demo script.

## 2026-06-29 — Issue #77: read_file_at_ref crashed the whole run on a corrupt .json in fixturesDir (unguarded twin of #73)
**Duration:** ~20 min · **Branch:** `session/2026-06-29-2339-issue-77`

- `tryReconstructFromAnyFixture` (`src/tools/read-file-at-ref.ts:86`) decoded each `.json` in `fixturesDir` with `fixtureLiteSchema.safeParse(JSON.parse(raw))` — the `JSON.parse` runs *outside* the `safeParse` guard, which only catches Zod mismatches, not a `SyntaxError`. So one corrupt/non-fixture `.json` in the walked directory threw a raw `SyntaxError` (not a `ToolError`), which propagated through `registry.invoke` and was re-raised by the executor, crashing the whole `AgentRun.run()` — even when the requested file is reconstructable from a perfectly good sibling fixture. The byte-for-byte unguarded twin of #73 (`search-repo.ts`).
- Reproduced firsthand with a throwaway vitest test (`mkdtemp` dir holding a `broken.json` + a valid added-file fixture): pre-fix `readFileAtRefTool.run` threw `SyntaxError` instead of reconstructing. Fixed by mirroring the #73 fix exactly — decode under `try/catch`, `continue` on `SyntaxError`, then `safeParse`. Lock test mirrors the #73 `search-repo` test and was confirmed failing on pre-fix code. Suite 315 → 316, `tsc --noEmit` clean.

**Why this work, this session:** third substantive issue of a multi-issue DAY run (after `llm-eval-harness` #122 and `rag-production-kit` #102). The five priority-tier repos were exhausted for this run, so rotated to non-tier `agent-orchestration-platform`; a dogfood hunter found this genuine #73-class bug, verified firsthand before acting.

**Open questions / blockers:** `run-check.ts:72` has the same `JSON.parse`-outside-`safeParse`, but it reads one deterministic fixture path (not a directory walk), so a corrupt fixture there only fails the matching request — filed as a separate low-priority follow-up candidate rather than scope-creeping this fix.

**Next session:** continue the loop; portfolio is deeply saturated (this run's dogfood sweep found 5 other repos clean).

## 2026-06-30 — Issue #79: run_check crashed the whole run on a corrupt checks fixture (single-path twin of #73/#77)
**Duration:** ~20 min · **Branch:** `session/2026-06-30-0310-issue-79`

- `run-check.ts:72` decoded its checks fixture with `fixtureSchema.safeParse(JSON.parse(raw))` — `JSON.parse` runs *outside* the `safeParse` guard (which only catches Zod mismatches, not a `SyntaxError`). So a malformed `.json` at the single deterministic checks path threw a raw `SyntaxError`; `executor.ts:135` re-raises any non-`ToolError` as a run crash (it only catches `ToolError` as a per-step error outcome), so one corrupt fixture poisoned the whole `AgentRun`. The last of the three `JSON.parse`-outside-`safeParse` sites (after #73 `search-repo`, #77 `read-file-at-ref`).
- Fixed by decoding under `try/catch` and mapping the `SyntaxError` to the **same** `ToolError("run_check", "internal", …)` the adjacent schema-mismatch path already raises — **not** `missing_fixture`. The distinction is deliberate: `readFile` already succeeded, so the file exists and only its *content* is corrupt (the corrupt-fixture case), whereas `missing_fixture` means "no fixture at all". A truncated/corrupt recording must surface as an error, not masquerade as "this ref has no checks". This also differs from #73/#77's `continue`-skip resolution because those walk a directory (a bad file is skipped in favor of others), while `run_check` reads one deterministic path — so the correct parallel is "treat malformed JSON identically to schema mismatch", which in this file already throws `ToolError("internal")`.
- Lock test writes `"{ not valid json"` at the checks path and asserts a `ToolError` (kind `internal`), not a raw `SyntaxError`; confirmed failing on pre-fix code via `git stash` (inverse safety net). Suite 316 → 317 passing, `tsc --noEmit` clean.

**Why this work, this session:** first substantive issue of a NIGHT multi-issue run. The priority tier had no actionable unblocked code work (llm-cost-optimizer #97 is a JT-blocked decision-revisit; the rest are demo-video captures), so D-007 fall-through to non-tier `agent-orchestration-platform`, which had a concrete, pre-filed #73-class bug.

**Open questions / blockers:** none — this closes the JSON.parse-guard arc across all three sites.

**Next session:** continue the loop; portfolio is deeply saturated.

## 2026-07-01 — Issue #81: fetch_pr was the fourth directory-walker missed by the JSON.parse-guard arc
**Duration:** ~25 min · **Branch:** `session/2026-07-01-0340-issue-81`

- A prior session recorded that the `JSON.parse`-guard arc was "closed across all three sites" (search-repo #73, read-file-at-ref, run-check #79) — but `fetch_pr` is a *fourth* directory-walking fixture tool, and it still had a bare `prFixtureSchema.safeParse(JSON.parse(raw))`. A corrupt/non-fixture `.json` in the fixtures dir threw a raw `SyntaxError` (not a `ToolError`); the executor re-raises non-`ToolError` throws, so it aborted the whole run — with the valid target fixture present but unreached because the corrupt file sorted first. `fetch_pr` is the entry step of every eval, so the blast radius is large (filed priority:high).
- Surfaced by a dogfood hunter and reproduced myself (a throwaway vitest test: `search_repo` skipped the corrupt sibling, `fetch_pr` threw `SyntaxError`). Fixed by mirroring `search-repo.ts` — decode under try/catch, `continue` past bad files. +1 lock test (corrupt file sorts first). Suite 317 → 318, typecheck clean.

**Why this work, this session:** portfolio is deeply saturated. Two parallel dogfood hunt rounds (6 agent hunts + 3 self-hunts) came back NO_BUG_FOUND except this and the llm-eval-harness #130 pipe-escape — both confirmed real by my own repro and shipped.

**Open questions / blockers:** none — ready for review.

**Next session:** the four fixture-walkers now share the guard; a lightweight cross-tool lock test could prevent a fifth walker regressing.

## 2026-07-01 — Issue #83: unregistered primary step tool crashed the run instead of replanning
**Duration:** ~25 min · **Branch:** `session/2026-07-01-1548-issue-83`

- The executor's documented recovery contract (`docs/architecture.md`) says an unregistered tool name must surface as an `internal` `ToolError` observation the planner can replan around, not crash the run. That held for a misconfigured `fallbackTo` (`fallbackFor`) but **not** for the primary step tool: `invokeWithRetry`'s `registry.get(step.tool)` throws a plain `Error` for an unregistered name, which the catch re-raises as a "programmer bug", aborting `AgentRun.run` before `finalize()` — no review, no replan, no terminal trace event. `step.tool` is planner-supplied (LLM-generated in `AnthropicPlanner`), so a hallucinated/typo'd name is exactly the recoverable-misconfiguration case. Reproduced firsthand before fixing.
- Fixed with an early guard at the top of `runStepWithRetryAndFallback`: an unregistered primary tool returns a `ToolError` observation that routes through the existing replan machinery. The guard belongs there, not in `invokeWithRetry`, because the catch would otherwise call `fallbackFor(primaryName)` whose own `registry.get` re-throws the same plain Error (double crash). Extended the architecture-doc contract to name the primary path. +1 test (fails pre-fix); the existing "registered tool throws a plain Error still re-raises" behavior is unchanged. Suite 318 → 319, typecheck clean. Filed `priority:high` (crash-the-whole-run on untrusted LLM output, same class as #81).

**Why this work, this session:** third issue of the DAY run, reached via a final bounded 2-repo TS sweep (agent-orchestration-platform + nextjs). The nextjs hunter returned NO_BUG after exhaustive partial-JSON/SSE fuzzing; the agent-orch hunter surfaced this contract asymmetry.

**Open questions / blockers:** none — ready for review.

**Next session:** continue the loop; portfolio saturation is deep (this run found 4 real bugs across ~13 hunts).

## 2026-07-02 — Issue #85: CLI approval provider hangs on the 2nd approval (~25 min)

**What got done.** `readSingleLine` in `src/agent/cli-approval.ts` kept a per-call local buffer and threw away everything after the first newline. But a single `createCliApprovalProvider` is called once per destructive tool in a run, all sharing one stdin stream, and Node can deliver several buffered lines in one `data` chunk (piped stdin, fast typist). So the first approval consumed the whole chunk, dropped the residual, and the next approval blocked forever on a newline that had already arrived — a human-in-the-loop deadlock plus silent loss of the operator's answer. Fixed by hoisting a persistent carry buffer into the provider closure: `readSingleLine` resolves from an already-buffered line first, keeps the bytes after the newline as carry, and clears on stream end. Added a regression test (two answers in one chunk on a shared `PassThrough`) that TIMEOUTs pre-fix and passes post-fix. Full vitest suite green (320 passed, 5 skipped live-DB), typecheck clean; the public signature is unchanged.

**Why prioritized.** Fourth issue of the day run, from the final pair of dogfood hunts after the priority tier was exhausted. The Python filesystem-sandbox MCP server came up clean under a thorough sandbox-escape probe; the TS orchestration platform surfaced this. Filed priority:high because it's a deadlock plus data loss on the safety-critical approval path, same robustness-contract precedent as #81/#83. Reproduced firsthand before filing and fixing.

**Open questions / blockers.** None. A larger refactor to a shared readline interface was deferred; the carry-buffer fix is the minimal correct change.

## 2026-07-04 — Issue #87: architecture-doc symbol-resolution lock (missed portfolio-ops #55 TS repo)
**Duration:** ~40 min · **Branch:** `session/2026-07-04-0339-issue-87` · **PR:** #88

- This repo was a hidden gap in portfolio-ops #55's TS-side propagation: an early #55 comment listed it among the repos to do, but the final status table dropped it, so it never got the symbol lock (unlike nextjs #77, mcp #83, ai-app #73). Found it by checking each TS repo's arch-doc test for a symbol axis after finishing the three listed ones — this one had only the four original invariants.
- Added a symbol-resolution invariant. This doc has the richest symbol vocabulary of any TS repo (~33 backtick identifiers), so the ground truth had to include **method declarations**, not just top-level ones — the doc names store/planner/executor methods (`getRun`, `writeRun`, `initialPlan`, `runStepWithRetryAndFallback`). Three hard-pinned exception sets carry the rest: `EXTERNAL_SYMBOLS` (npm `optionalDependencies`), `PLANNED_SYMBOLS` (`AnthropicPlanner` — the documented-future planner, verified via source comments, not drift), `DOC_FIELDS` (`toolName`, `fallbackTo`). All 33 classify (28 declarations/methods, 5 pinned); vitest 328 green, tsc clean.

**Why this work, this session:** fifth iteration of the NIGHT loop; a genuine #55 gap discovered by auditing beyond the tracked list. High value — the largest doc surface, previously unlocked.

**Open questions / blockers:** none — ready for review. Two local gotchas noted for next time: this repo uses `noUncheckedIndexedAccess` (regex `m[1]` needs `!`), and has no lint step (CI gates are typecheck + vitest only).

**Next session:** portfolio-ops #55 TS side is now truly complete across four repos; close #55 once #77/#83/#73/#88 merge.

## 2026-07-04 — Issue #89: GFM table pipe-escaping in the eval PR comment
**Duration:** ~25 min · **Branch:** `session/2026-07-04-1516-issue-89` · **PR:** #90

- `escape()` in `src/eval/comment.ts` HTML-escaped `&`/`<`/`>` for the sticky eval comment's HTML context but never escaped the GFM table-cell delimiter `|`. A fixture's `fixture_id` is an unconstrained `string`, so an id like `lang=py|framework=next` split into an extra table column and corrupted the whole rendered eval-comment table's alignment on a PR. Backticks don't protect a literal `|` — GitHub splits cells on unescaped pipes before parsing inline-code spans. Extended `escape()` to also replace `|` → `\|` (both its call sites are table cells) and added a regression test that a piped `fixture_id` keeps the data row's column count equal to the header's. Reproduced live before the fix: 8 fields vs the header's 7.
- The recommendation cells are enum-typed today, so they can't carry a pipe in well-typed code (a test asserting a piped recommendation failed strict `tsc` and was dropped); they still flow through the same helper, so they're covered defensively. `npm run typecheck` + `npm test` (329 passing) green.

**Why this work, this session:** Portfolio is deeply saturated — zero `priority:high` issues anywhere, no freshness floor crossed, and the two open `priority:med` issues (llm-cost-optimizer #97, vector-search #71) are both JT-decision one-way blockers already deferred twice. A thorough manual review plus a subagent bug-hunt of priority-tier `llm-cost-optimizer` came up empty (it's airtight). Pivoted to the recurring, proven dogfood grep for table-row emitters interpolating free-form strings; it surfaced this repo as the one TS emitter the portfolio-wide pipe-escaping sweep (#130/#134/#79/#100) had missed.

**Open questions / blockers:** none — ready for review.

**Next in this session's loop:** rotate to the next priority-tier repo per selection; the pipe-escaping class is now swept across all emitters found.

## 2026-07-05 — Issue #91: read_file_at_ref searches all fixtures for an added entry (~15 min)

**What got done.** `tryReconstructFromAnyFixture` in `src/tools/read-file-at-ref.ts` loops over every replay fixture to reconstruct a file's added-side content, but it aborted the whole search with `return null` the moment it found the file in a non-`added` state. Because a PR file's status is relative to its base and the loop matches fixtures on `pr.head === ref` only, the same file at the same head ref can be `modified` vs one base and `added` vs another; if the modified fixture was visited first, the tool threw `not_found` even though a later fixture held a reconstructable `added` patch. Fixed by `continue`ing past a non-`added` match instead of returning null, so the search only fails after exhausting every fixture. Added two tests: a modified-first/added-second pair now reconstructs the content (fails pre-fix), and a file that is only ever modified still raises not_found (no false success). Full suite green (331 passed), typecheck clean. PR #92.

**Why prioritized.** Third issue of the night run, from a parallel dogfood bug-hunt across the not-yet-saturated repos. Confirmed firsthand with a scratch vitest test that failed pre-fix before writing the real fix. The change is strictly safe — it only newly recovers the added-in-a-later-fixture case and leaves every single-fixture outcome unchanged — consistent with this file's earlier robustness fixes (#61, the JSON.parse guard).

**Open questions / blockers.** None — ready for review.

## 2026-07-06 — Issue #93: README HITL example crashed on stale enum value (~30 min)

**What got done.** The README's "Interactive approval" example — the one demonstrating the human-in-the-loop gate on the single destructive tool — passed `recommendation: "approve with comments"` (space-separated), but #63 had switched the `post_review_comment` input enum to the underscored `"approve_with_comments"`. The code and its tests were fixed then; the README example was not, so the documented snippet threw `input_validation` on copy-paste before ever reaching the approval gate. Reproduced firsthand (`buildDefaultRegistry()` + `invoke`): the space form errors, the underscore form runs. Corrected `README.md:154` and added `test/readme-recommendation-enum.test.ts`, which asserts every README `recommendation:` literal is a member of the tool's live enum (`postReviewCommentTool.inputSchema`) — it fails on the pre-fix README, closing the gap where nothing executes the README's TS blocks. `npm test` 333 passed, `tsc` clean.

**Why prioritized.** Third real bug of the NIGHT loop, surfaced by the wave-5 "run the documented example end-to-end" lens (the same lens behind mcp #86 and chunking #112). Static code hunts had all gone empty; running the shipped examples is what keeps yielding in the saturated state.

**Open questions / blockers.** None — ready for review.

**Next session:** two more findings from the same wave landed in mcp-server-cookbook (filesystem-sandbox-py drops `isError`; internal-tools-bridge README fresh-clone numbers stale) — being worked serially this run.

## 2026-07-08 — Issue #95: executor fallback fires on non-retryable validation errors
**Duration:** ~35 min · **Branch:** `session/2026-07-08-0328-issue-95`

- `runStepWithRetryAndFallback` routed **every** non-approval `ToolError` to the declared `fallbackTo` tool — including `input_validation`/`output_validation`, which the retry layer treats as non-retryable (`DEFAULT_RETRYABLE_KINDS = ["internal"]`) and short-circuits with zero retries. But `docs/architecture.md` says the fallback fires "on exhaustion" of the primary's retries — a non-retryable kind never exhausts, yet the fallback ran anyway. Two failures: for `output_validation` the primary's `run()` had **already committed its side effect** before output validation failed, so firing the fallback **double-executed** the action; and the primary's real error was **swallowed** (the observation reported the fallback's success as `outcome: ok`, the cause surviving only in the `fallback_used` trace).
- Fixed by gating the fallback on the primary error kind being retryable (its policy's `retryableErrorKinds ?? DEFAULT_RETRYABLE_KINDS`), mirroring the #69 approval-kind gate; non-retryable kinds now surface to the replan path. Preserves the existing fallback-on-`internal` behavior.
- Reproduced firsthand with 3 new executor tests (2 fail pre-fix): `output_validation` no longer double-executes and surfaces as the step outcome; `input_validation` doesn't fire the fallback; a retryable `internal` error STILL falls back. Full suite 333 → 336 (pg-store skipped — needs Postgres), `tsc --noEmit` clean.

**Why this work, this session:** static queue exhausted; this NIGHT run's six parallel fresh-lens dogfood hunts surfaced it (retry/fallback/HITL-correctness lens), one of two real hits. The #69 fix had gated only the two approval kinds from the fallback; the retry layer separately excludes validation kinds, and the fallback layer had no such gate — no test had ever exercised fallback with a validation error.

**Open questions / blockers:** none — ready for review.

**Next session:** the "retry/fallback kind-gating parity" lens (the two recovery layers must agree on which error kinds are recoverable) is swept on aop — the only repo with this two-layer construct. Don't re-sweep elsewhere.

## 2026-07-08 — Issue #97: MemoryStore nested-object aliasing lets callers mutate stored trace history
**Duration:** ~30 min · **Branch:** `session/2026-07-08-0348-issue-97`

- `MemoryStore.writeRun`/`getRun` did `events: [...events]` — a shallow copy of only the array. Every event object (and its nested `step`/`plan`/`observation`/`ToolError` payload) stayed shared by reference, so a caller holding a returned event, or the executor still holding the objects it passed to `writeRun`, could mutate the stored trace history. The class docstring claimed the opposite ("callers can't mutate the stored state by holding a reference"). It was also a MemoryStore↔PgStore parity break: PgStore serializes each payload to JSONB (`JSON.stringify`) so it's fully isolated; MemoryStore (what the store tests and demo server run against) was not.
- Fixed by deep-copying events via `JSON.parse(JSON.stringify(...))` on both boundaries — chosen over `structuredClone` specifically to match PgStore's JSONB round-trip semantics exactly (it honors `toJSON`, e.g. `ToolError.toJSON`), closing the parity break rather than introducing a new divergence. Events are JSON-serializable by construction.
- Reproduced firsthand: 2 of 3 new store tests fail on pre-fix code (read-side "TAMPERED", write-side "TAMPERED_VIA_INPUT"); the third is a cost-bearing-event round-trip losslessness guard. Full suite 333 → 336 (pg-store skipped — needs Postgres), `tsc` clean.

**Why this work, this session:** the NIGHT run's final wave (3 hunts on genuinely un-hunted surfaces) surfaced this — the other two (mcp github-gists auth/SSRF, mcp internal-tools-bridge injection) came back honestly empty. Second aop issue of the run, but a distinct surface (trace store vs the executor #95 fallback gate) — this is the two-backend-parity aliasing lens (serializing backend isolates for free, by-reference one breaks parity), same class as lco #131 cache-poisoning.

**Open questions / blockers:** none — ready for review.

**Next session:** the two-backend-parity aliasing lens is now swept on aop's trace store. Not reachable in the shipped UI read path today (it JSON-stringifies immediately), but the write-side + idempotent-replay path is, and the contract was documented-and-false — worth the fix.
