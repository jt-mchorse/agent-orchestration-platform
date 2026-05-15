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
