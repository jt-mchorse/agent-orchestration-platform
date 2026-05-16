# Core Decisions

Strategic decisions for this repo, with reasoning. Append-only — superseded decisions are marked, not removed.

## D-001 — Scope locked to portfolio handoff §2 (2026-05-10)
**Decision:** Scope of this repo is fixed by the portfolio handoff document, section 2.

**Why:** The handoff spec was deliberated; ad-hoc scope expansion within a session is the failure mode this prevents.

**Alternatives considered:** None — this is a baseline.

**Reversibility:** Expensive. Scope changes require a deliberate revisit and a new decision entry.

**Related issues:** —

## D-002 — Agent use case = PR review (not research brief) (2026-05-15)
**Decision:** This repo's concrete agent is a **PR review agent**: input is a GitHub PR (`owner/repo#N` live, or fixture in replay mode), output is a single structured review comment with a summary paragraph, severity-tagged findings, and a final recommendation. Research brief is rejected.

**Why:** Both alternatives are real-shape single-purpose agents. PR review wins on five concrete criteria documented in [`docs/use-case.md`](../docs/use-case.md): (1) real input corpus already exists in the `jt-mchorse/*` portfolio (every committed PR is a candidate), (2) outputs are scorable against the actual human-review thread on the same PR, (3) the HITL checkpoint has a real motivation (posting a public comment on someone else's PR is a real "destructive on the social graph" surface), (4) the 60-second demo story is tight ("watch the agent review this PR"), and (5) it dogfoods into the portfolio's existing weekly review cadence rather than inventing a new workflow. Research brief is softer on every row that matters — particularly the scorability and HITL motivation criteria.

**Alternatives considered:**
- Research brief agent — rejected because brief quality is a weak proxy for agent loop correctness, and there's no natural HITL surface that maps to a real destructive action.
- Both agents (multi-agent) — rejected because the repo's spec (handoff §2) explicitly says single-agent depth, not breadth.

**Reversibility:** Expensive. Five downstream issues (#2 tool registry, #3 planner loop, #4 HITL, #6 trace UI, #7 evals) target this concrete shape; switching after this decision would force a re-scoping of all five.

**Related issues:** #1, #2, #3, #4, #6, #7

## D-003 — `Planner` is a three-method TypeScript interface, not a single-method one (2026-05-16)
**Decision:** The agent loop talks to its decision-maker through a `Planner` interface with three async methods: `initialPlan(input)`, `revise(state, reason)`, and `finalize(state)`. Each maps to one distinct phase of the run (start, error-handling, end). The portfolio's "one-method-Protocol per backend" pattern (Tool, Reranker, Embedder, Backend) is followed *per phase*, not collapsed into a single `step()` method that switches internally on what's needed.

**Why:** The three operations are semantically different — `initialPlan` produces a plan from nothing, `revise` consumes an error reason, `finalize` produces a `Review` shape (not a plan). Collapsing them into one method would force discriminated-union inputs that's harder to implement correctly for a future `AnthropicPlanner` (each method maps to a different system-prompt shape) and harder to test (the `ScriptedPlanner` would need to inspect the call kind every time). Three small methods are the right amount of structure here.

**Alternatives considered:**
- Single-method `step(state) → next` Protocol — rejected: collapses three different operations into one, makes the LLM-driven implementation harder because each call shape wants different prompting.
- React-style "one function per decision point" — rejected: not idiomatic for TypeScript, harder to compose with async + dependency injection.
- Class hierarchy with `BasePlanner` — rejected: same complaint as in `llm-eval-harness` (D-005 there); one interface, two concrete implementations, no ABC needed.

**Reversibility:** Cheap. The three methods are small; collapsing or splitting later is a one-PR refactor.

**Related issues:** #3, #6, #7

## D-004 — Re-plan budget defaults to 5, configurable per run (2026-05-16)
**Decision:** `AgentRun` accepts an `ExecutorOptions.maxReplans` override; default is `DEFAULT_MAX_REPLANS = 5`. When the budget is exhausted, the executor emits an `aborted` trace event with `reason: max_replans_exceeded:N` and proceeds to `finalize()` with the observations gathered so far. The planner still gets a chance to assemble a partial review.

**Why:** Without an upper bound, a misbehaving planner (or a deterministic tool-error + revise-to-same-plan loop) could run forever and burn dollars on a real LLM-driven planner. 5 is loose enough for legitimate paths (fetch fails → planner adapts to a different repo handle → succeeds in two replans, with margin) and tight enough that runaway loops surface as test failures within seconds. Per-run override matters because eval suites that intentionally test recovery paths may want a higher budget, and production guardrails may want a lower one.

**Alternatives considered:**
- Unbounded loop + external kill switch — rejected: makes test-side determinism harder; the kill switch would still need a bound.
- Hardcoded 3 replans — rejected: too tight for normal paths.
- Dollar/token budget — deferred: meaningful only once `AnthropicPlanner` lands; cost-budget is a #6/#7 concern, not #3's.

**Reversibility:** Cheap. The constant and option live in one file; the abort path is a single trace event the UI (#6) already needs to render.

**Related issues:** #3

## D-005 — `TraceStore` writes at finalize-time; cost aggregator skips missing fields (2026-05-16)
**Decision:** `TraceStore.writeRun(input)` persists the entire run (summary + all events) once at finalize-time, not per-event. `aggregateCost(events)` sums each `Observation.cost` field across the run, skipping values that are absent rather than treating them as zero.

**Why:** The in-memory `Trace` is already the streaming surface — the executor accumulates events as the run unfolds. Persisting per-event would multiply Postgres round-trips by ~10× per run for no real benefit; the viewer doesn't need live updates today. On the cost side, observations that don't report a cost are "unknown", not "$0.00" — a partial cost report should show as a partial total so the operator can tell whether the gap is a missing instrumentation or a genuinely-free call. Treating absent as zero would hide bugs in tools that should be reporting cost.

**Alternatives considered:**
- Stream per-event inserts to Postgres — rejected: more round-trips, no live-UI use case today.
- Treat missing cost as zero — rejected: hides missing instrumentation.
- Fail on partial cost — rejected: too brittle, especially while tools are landing piecemeal.

**Reversibility:** Cheap. A streaming `writeEvent(runId, event)` method can be added later without changing the existing contract.

**Related issues:** #6, #7

## D-006 — Trace viewer is React via ESM CDN + `htm`, no bundler (2026-05-16)
**Decision:** The trace viewer in `src/ui/` loads React 18 via an ESM import map pointing at `esm.sh`, and uses `htm` for JSX-free templating. No bundler. No `react`/`react-dom` package in the npm-side dep graph.

**Why:** The issue requires a "minimal React UI". Vite or webpack would multiply the repo's surface (config files, build steps, transitive deps) for a viewer that's three files of code total. The CDN + `htm` path keeps the React requirement satisfied with zero npm-side React surface — same dep-discipline reasoning as the stdlib `http.server` in the demo (D-011 in `rag-production-kit`). The downside is that the viewer needs a network on first load to hit `esm.sh`; that's acceptable for a debug surface.

**Alternatives considered:**
- Vite/webpack bundler — rejected: too much infra for a debug-only viewer.
- Plain HTML/JS, no React — rejected: violates the issue's "React UI" wording, and a future contributor would have to re-implement state with vanilla event handlers.
- Preact swap — rejected: portfolio repos that use a frontend (`nextjs-streaming-ai-patterns`) use React proper; standardizing on Preact here would diverge.

**Reversibility:** Cheap. A switch to a bundled React app is a one-time config job; the viewer's logic in `src/ui/app.js` would carry over with minor tweaks.

**Related issues:** #6

## D-010 — Agent eval suite ships in TypeScript, not Python (2026-05-16)
**Decision:** The agent eval suite (`src/eval/`) is entirely TypeScript. It does not `pip install eval-harness` in the GitHub Action. The sticky-PR-comment pattern is borrowed from `llm-eval-harness` D-009 (hidden HTML marker, `findStickyCommentId` + `upsertStickyComment`), but the two repos use distinct markers (`<!-- agent-eval:sticky-comment -->` vs `<!-- eval-harness:sticky-comment -->`) so a downstream consumer running both actions doesn't collide.

**Why:** The `Review` shape (summary + structured findings + recommendation) lives in TypeScript already. Adding a Python install step to the agent's CI workflow would add ~30 s per PR for `pip install -e .[eval]`, plus another tens of seconds for cross-language IPC (the agent writes JSON, Python reads + scores it, posts the comment). All of that for *the same sticky-comment shape* eval-harness already implements. The cleaner choice: re-implement the pattern in TS once (~150 lines), keep the action dep-graph at "node 20 + npm ci", and accept that the two repos own parallel implementations of the same idea. If a third repo adopts the pattern, the right move is to extract a shared package, not bridge to Python.

**Alternatives considered:**
- `pip install eval-harness` in the action — rejected: adds dep + minutes per PR for no capability unlock.
- Cross-language subprocess call (TS spawns Python `eval-harness comment`) — rejected: same install cost + brittle IPC + harder debugging.
- Run eval-harness as a separate workflow after the agent writes results — rejected: doubles the CI fan-out (two workflows on every PR) for the same end result.

**Reversibility:** Cheap. The TS module is ~150 lines; a future shared-package extraction is a clean refactor.

**Related issues:** #7

## D-011 — Findings precision/recall uses 1:1 fuzzy matching keyed by severity (2026-05-16)
**Decision:** `matchFindings(actuals, goldens)` builds a greedy 1:1 mapping between the agent's findings and the golden's, where two findings match iff (a) their `severity` is equal *and* (b) their token-level Jaccard similarity ≥ 0.30. The matching is greedy by best similarity: highest-scoring pair wins first, then both endpoints are removed, repeat.

**Why:** Without 1:1, a single agent finding that token-overlaps three golden findings would inflate recall to 3/N. Without the severity gate, a "praise" finding could match a "blocker" — clearly wrong. The Jaccard threshold of 0.30 is calibrated against the hand-labeled fixtures: lower lets unrelated findings match, higher misses genuinely-equivalent re-phrasings. The greedy approach is `O(|A| × |G|)` which is fine at the ~10-findings-per-fixture scale; an optimal Hungarian assignment would be `O(n³)` and not visibly better at this scale.

**Alternatives considered:**
- Unrestricted many-to-one matching — rejected: double-counts.
- Cosine similarity over embeddings — rejected: adds an embedder dep for short-text comparisons where Jaccard works fine.
- No severity check — rejected: lets semantically-incompatible findings match.

**Reversibility:** Cheap. The matching is one function; the Jaccard threshold is a single constant.

**Related issues:** #7
