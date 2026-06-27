# Use case — PR review agent

## What the agent does

**Input:** a GitHub Pull Request, identified by `owner/repo#N` (live) or by a
fixture JSON file (replay).

**Output:** a single structured review comment posted on the PR (live mode)
or written to stdout (replay mode), containing:

1. A **summary paragraph** in plain English: what the PR does, why, and the
   reviewer's overall confidence.
2. A list of **findings**, each tagged with severity (`blocker`, `concern`,
   `nit`, `praise`) and anchored to a file + line range.
3. A **final recommendation**: one of `request_changes`,
   `approve_with_comments`, `approve`.

The agent runs against one PR at a time. Multi-PR batching is out of scope.

## Why this and not "research brief"

Both alternatives in the issue (research brief vs. PR review) are real-shape
single-purpose agents that exercise tool use, planning, HITL checkpoints,
and trace observability. The decision criteria:

| Criterion | Research brief | PR review |
|-----------|----------------|-----------|
| Real input corpus already exists | No (need to invent queries) | **Yes** (every PR in `jt-mchorse/*`, including this one) |
| Output is concretely scorable | Hard (subjective brief quality) | **Easier** (compare to human reviewer's actual comments) |
| HITL checkpoint has a real motivation | Weak (write/don't-write a paragraph) | **Strong** (post/don't-post a comment on someone else's PR) |
| 60-second demo story | Decent | **Strong** ("watch the agent review this PR") |
| Tool-registry exercise | Web fetch, parse, summarize | **Web fetch, file read, code search, AST tools, MCP server for repo context** |
| Dogfooding into the portfolio | None | **Direct** — agent reviews PRs in the same org |

The PR-review framing wins on every row that matters for this repo's
positioning. The research-brief framing isn't *wrong*, but its inputs and
outputs are softer, and the demo lives or dies on the brief's prose
quality — which is a much weaker proxy for "is the agent loop working" than
"did the agent flag the same blocker the human reviewer did."

## Tools the agent will need (scope of #2)

The PR-review framing locks in the seed tool set. Each is a separate
implementation under #2 but the contracts are knowable now:

- **`fetch_pr(owner, repo, number)`** — load metadata + diff. In replay
  mode, reads from `fixtures/sample-prs/`.
- **`read_file_at_ref(owner, repo, path, ref)`** — load a file at a specific
  commit so the agent can see context outside the diff.
- **`search_repo(owner, repo, query)`** — code search via GitHub's API for
  cross-file references.
- **`run_check(owner, repo, ref, check_name)`** — query CI status; the agent
  should *use* CI signal rather than re-derive it.
- **Custom MCP server: `portfolio-context`** — exposes the target repo's
  `MEMORY/core_decisions_*.md` so the agent can flag PRs that conflict with
  recorded decisions. This is the "custom MCP server" deliverable from §2;
  it's portfolio-specific by design (and lands in `mcp-server-cookbook`
  alongside).

Five tools, one of which is a custom MCP server, satisfying #2's acceptance
criteria.

## HITL checkpoints (scope of #4)

The destructive action in this agent's surface is **posting a public comment
on someone else's PR**. The checkpoint pauses before the comment is posted,
shows the operator the rendered comment, and asks for explicit approval.
Replay mode never posts, so the checkpoint is a no-op there.

Note: there's no "destructive on the codebase" surface — the agent doesn't
edit files or push commits. It only reads.

## Trace observability (scope of #6)

Every tool call, every model call, every checkpoint pause, and every token
cost gets persisted to Postgres with a stable `run_id`. The minimal UI is one
screen showing a list of runs and one screen showing a single run's
timeline. That UI is the operator's debugging surface.

## Eval suite (scope of #7)

Golden traces are recorded against the committed sample PRs. Each fixture
has a hand-labeled "what should the reviewer flag" answer key (committed
under `fixtures/sample-prs/<slug>.golden.json` when #7 lands). The eval
suite scores the agent's findings against the answer key with both exact-
match and LLM-as-judge metrics, importing `llm-eval-harness`.

## What's *not* in scope

- Posting reviews unattended (no HITL bypass mode in v0).
- Writing code or pushing commits.
- Reviewing PRs in repositories outside `jt-mchorse/*` (no auth boundary
  beyond the operator's PAT).
- Multi-agent orchestration. This is one agent, deliberately.
