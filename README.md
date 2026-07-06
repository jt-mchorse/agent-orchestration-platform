# agent-orchestration-platform
> A real single-purpose agent: reads a GitHub PR, calls tools, pauses for human approval, posts a structured review. Tool registry + custom MCP server + HITL checkpoints + full trace observability + eval suite.

![CI](https://github.com/jt-mchorse/agent-orchestration-platform/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## What this is

A **PR review agent**. You hand it `owner/repo#N`, it loads the diff, calls
its tool registry to gather context (file content at the base ref, related
code via repo search, CI status, the target repo's recorded core decisions
via a custom MCP server), pauses for explicit operator approval before
posting anything publicly, and on approval emits a single structured review
comment: a plain-English summary, a list of findings tagged by severity
(`blocker` / `concern` / `nit` / `praise`) and anchored to file + line, and
a final recommendation. In replay mode (against committed fixtures), the
checkpoint is a no-op and the output goes to stdout.

The agent is one agent, deliberately. The point of this repo isn't
multi-agent orchestration; it's *single-agent depth* — visible planning,
real tools (including one custom MCP server), real human-in-the-loop on the
one destructive surface (posting on someone else's PR), and a real trace
store so you can replay any run and see every decision the agent made.

The choice between this framing and "research brief" is locked as **D-002**
(PR review wins on real input corpus, scorable output, real HITL motivation,
demo strength, and dogfooding into the portfolio — see
[`docs/use-case.md`](docs/use-case.md) for the full table). Two real PR
fixtures from `jt-mchorse/*` are committed under
[`fixtures/sample-prs/`](fixtures/sample-prs/) so subsequent issues (#2 tool
registry, #3 planner loop, #6 trace UI, #7 eval) have hermetic local inputs.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full diagram
and the design decisions behind each component (D-002…D-013). In
short: **input → planner → executor (with tool calls) → re-planner on
unexpected output → HITL checkpoint → posted review**, with every step
logged to a trace store and scorable against committed golden answer keys.

## Quickstart

Three runnable surfaces ship today: the tool registry, the agent
executor + planner loop, and the eval suite. Install once:

```bash
npm install
npm test                  # full hermetic suite (no API key, no Postgres)
npm run typecheck
```

Run the deterministic eval against the two committed PR fixtures —
no API key, no network, no GitHub auth:

```bash
npm run eval -- --dry-run                # rendered markdown to stdout
npx tsx scripts/render-eval-snapshot.ts  # writes docs/eval_snapshot.md
```

Lint a fixture or golden JSON file before spending eval tokens (#39):

```bash
npm run validate -- fixtures/sample-prs/<slug>.json            # fixture
npm run validate -- fixtures/sample-prs/<slug>.golden.json --golden
```

`validate` walks the JSON in collecting mode and surfaces every
malformed row in one pass — first TypeScript port of the validator
pattern shipped in the four Python sister repos this week. Exit codes
`0 clean / 1 findings / 2 I/O error`.

The composite + per-fixture scores in [`docs/eval_snapshot.md`](docs/eval_snapshot.md)
are byte-locked to the renderer by `test/readme-snapshot.test.ts`, so a
silent change in `renderEvalMarkdown` or `scoreReview` fails CI.

Browse a recorded run in the trace viewer (after a real run produces a
`results/eval-*.json`):

```bash
npm run trace:server      # → http://localhost:8766/  (React via ESM CDN, D-006)
```

Use the registry from your own script:

```ts
import { buildDefaultRegistry } from "./src/index.js";
import path from "node:path";

const registry = buildDefaultRegistry();
const ctx = { mode: "replay" as const, fixturesDir: path.resolve("fixtures/sample-prs") };

const pr = await registry.invoke(
  "fetch_pr",
  { owner: "jt-mchorse", repo: "vector-search-at-scale", number: 6 },
  ctx,
);

const hits = await registry.invoke(
  "search_repo",
  { owner: "jt-mchorse", repo: "vector-search-at-scale", query: "terraform", maxResults: 5 },
  ctx,
);

// Fifth tool: queries the local portfolio-context MCP server for the
// target repo's recorded core decisions, so the planner can flag PRs that
// conflict with non-superseded decisions. Requires PORTFOLIO_ROOT in env.
process.env.PORTFOLIO_ROOT = path.resolve("../..");
const decisions = await registry.invoke(
  "get_portfolio_context",
  { repo: "agent-orchestration-platform" },
  ctx,
);
```

All five tools from `docs/use-case.md` are wired: `fetch_pr`,
`read_file_at_ref`, `search_repo`, `run_check`, and `get_portfolio_context`.
The fifth tool dispatches through a **custom MCP server**
(`mcp-server/portfolio-context/`) which exposes
`get_repo_core_decisions(repo)` over the standard MCP protocol — the agent
talks to it the same way Claude Desktop would talk to any third-party
server. The server is also runnable as a standalone stdio binary
(`dist/mcp-server/portfolio-context/bin.js`) after `npm run build`, with
`PORTFOLIO_ROOT` set in its environment.

A sixth tool, `post_review_comment`, is the one **destructive** surface in
the registry (it would post a public review comment on someone else's PR
in live mode). The registry blocks destructive tools unless the
`ToolContext` carries an `approvals` provider that returns `approved:
true`:

```ts
import {
  buildDefaultRegistry,
  createCliApprovalProvider,
  autoApproveProvider,
} from "./src/index.js";

const registry = buildDefaultRegistry();

// Interactive: print the rendered comment to stderr, read y/n on stdin.
const approvals = createCliApprovalProvider();

await registry.invoke(
  "post_review_comment",
  {
    owner: "jt-mchorse",
    repo: "rag-production-kit",
    number: 9,
    summary: "Adds hybrid retrieval with reasonable defaults.",
    findings: [
      { severity: "concern", file: "src/retrieve.py", line_start: 14, line_end: 22,
        message: "RRF k constant deserves a comment." },
    ],
    recommendation: "approve_with_comments",
  },
  { mode: "replay", fixturesDir: "fixtures/sample-prs", approvals },
);

// Replay / test runs: skip the prompt with the auto-approve provider.
// (The live-mode posting path is stubbed until the planner (#3) wires it.)
```

If a destructive tool is invoked without an `approvals` provider, the
registry throws `ToolError` with `kind: "approval_missing"` — failing
closed rather than open.

### Retry and fallback (#5)

Tool annotations carry an optional `retry: RetryPolicy` and `fallbackTo:
string`. `AgentRun` wraps every step in three recovery layers, in this
order: retry on the primary → one-hop fallback to an alternative tool →
planner replan. Each retry attempt emits a `retry_attempted` trace event;
the fallback emits a `fallback_used` event. The planner sees exactly one
observation per step regardless of how many retries or fallbacks fired —
the recovery details live in the trace, not in the planner's input.

```ts
const flakyApi: Tool<typeof inputSchema, typeof outputSchema> = {
  name: "flaky_api",
  description: "third-party API that occasionally 502s",
  inputSchema,
  outputSchema,
  annotations: {
    retry: { maxAttempts: 3, backoffMs: 100, backoffMultiplier: 2 },
    fallbackTo: "cached_api",  // a registered alternative with the same input shape
  },
  async run(input) { /* ... */ },
};
```

Defaults: one attempt (no retry), default `backoffMultiplier` of 2.0,
and only `kind: "internal"` errors are retried — `input_validation`,
`output_validation`, `approval_*`, and `not_found` short-circuit
immediately because retrying them with the same input can't help.
Override via `RetryPolicy.retryableErrorKinds` when a specific tool's
transient failures surface as a different kind. See
[`docs/architecture.md`](docs/architecture.md) for the recovery-layer
diagram and [D-012](MEMORY/core_decisions_human.md) for the rationale on
annotation-vs-policy-map.

## Benchmarks / Results

Today's eval numbers from the committed scripted planner against the two
hand-labeled fixtures under `fixtures/sample-prs/`. These are the real
outputs of `evaluateAll(discoverCases(...))`, not placeholders. The
current scripted planner is deliberately a baseline (it deduces a
recommendation from the diff's `request_changes` keyword count and emits
zero structured findings), so the composite is **honest-low**, not aspirational:

| metric | value |
| --- | --- |
| composite mean | **0.345** |
| recommendation accuracy | **50%** (1 / 2) |
| findings F1 mean | **0.000** |

| fixture | rec match | findings F1 | composite |
| --- | :---: | ---: | ---: |
| `rag-production-kit_pr9_hybrid_retrieval` | ✗ | 0.000 | 0.093 |
| `vector-search-at-scale_pr6_terraform_infra` | ✓ | 0.000 | 0.597 |

Source: [`docs/eval_snapshot.md`](docs/eval_snapshot.md), regenerable with
`npx tsx scripts/render-eval-snapshot.ts`. The snapshot file is locked to
the live renderer in `test/readme-snapshot.test.ts` so the table and the
code can't silently diverge. When the planner is upgraded to a real
LLM-backed implementation, regenerating the snapshot will move these
numbers and the test will fail loudly until the README is updated.

## Demo

```bash
bash scripts/capture_demo.sh
```

The capture script ([#16], `scripts/capture_demo.sh`) drives two
surfaces end-to-end on a fresh clone with no API key and no Postgres:
`npm run eval -- --dry-run` prints the rendered sticky-comment
markdown plus the composite/per-fixture table to stdout, then `npm
run trace:server -- --memory` is spawned in the background (D-006:
React + ESM-CDN viewer, no bundler) seeded with two synthetic runs so
the empty-state UI doesn't ship, and `curl /api/runs` shows the exact
JSON shape the React UI consumes. JT records the 60-second GIF/video
over the script's stdout plus a manual browser tour during the
trace-server section; CI runs it with `CAPTURE_PACE_SECONDS=0` (and
pins each surface in `test/capture-demo-smoke.test.ts`) so the demo
can't bitrot.

Real-PR runs swap to `PgStore` via `DATABASE_URL`; the demo uses
`--memory` and the committed `fixtures/sample-prs/` so it stays
hermetic.

[#16]: https://github.com/jt-mchorse/agent-orchestration-platform/issues/16

## Why these decisions

See [`MEMORY/core_decisions_human.md`](MEMORY/core_decisions_human.md). Notable:

- **D-002.** PR review agent (not research brief). Reversibility:
  **expensive** — every downstream issue targets this concrete shape.

## License

MIT
