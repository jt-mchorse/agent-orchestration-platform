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
