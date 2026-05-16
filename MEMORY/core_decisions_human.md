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
