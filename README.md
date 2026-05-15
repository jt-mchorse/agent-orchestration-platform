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

See [`docs/architecture.md`](docs/architecture.md) for the full diagram. In
short: **input → planner → executor (with tool calls) → re-planner on
unexpected output → HITL checkpoint → posted review**, with every step
logged to a trace store and scorable against committed golden answer keys.

## Quickstart

The agent CLI lands with #3 (the planner). Today, the **tool registry** is
runnable against the committed PR fixtures — that's the interface the planner
will drive. Install and exercise it:

```bash
npm install
npm test                  # 44 tests across the registry, 6 tools, parser, MCP server, and HITL
npm run typecheck
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
    recommendation: "approve with comments",
  },
  { mode: "replay", fixturesDir: "fixtures/sample-prs", approvals },
);

// Replay / test runs: skip the prompt with the auto-approve provider.
// (The live-mode posting path is stubbed until the planner (#3) wires it.)
```

If a destructive tool is invoked without an `approvals` provider, the
registry throws `ToolError` with `kind: "approval_missing"` — failing
closed rather than open.

## Benchmarks / Results

Pending the eval suite (#7). Per the project's no-fabricated-benchmarks
rule, this section will populate with real numbers when #7 ships — recall
on golden findings and LLM-as-judge calibration against human-labeled
samples.

## Demo

60-second demo pending — meaningful only once #2/#3/#4 land so the agent
actually produces output to demo.

## Why these decisions

See [`MEMORY/core_decisions_human.md`](MEMORY/core_decisions_human.md). Notable:

- **D-002.** PR review agent (not research brief). Reversibility:
  **expensive** — every downstream issue targets this concrete shape.

## License

MIT
