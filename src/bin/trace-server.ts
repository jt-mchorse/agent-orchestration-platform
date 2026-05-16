/**
 * `npm run trace:server` entrypoint.
 *
 * Starts the trace viewer on the configured store. By default uses
 * `PgStore` against the `DATABASE_URL` env var; pass `--memory` to start
 * with `MemoryStore` (useful for trying the UI without bringing up
 * Postgres). When using memory mode, a couple of synthetic runs are
 * inserted so the UI has something to render.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../trace/store.js";
import { PgStore } from "../trace/pg-store.js";
import { createTraceServer } from "../ui/server.js";
import type { TraceStore, WriteRunInput } from "../trace/store.js";

async function maybeSeedMemoryStore(store: MemoryStore): Promise<void> {
  // Two synthetic runs so the empty-state UI doesn't feel broken on a
  // fresh `--memory` boot. Real persistence is the PgStore path.
  const sampleA: WriteRunInput = {
    run_id: "sample-finalized",
    pr: { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 },
    events: [
      { ts: Date.now() - 60_000, kind: "run_started", pr: { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 } },
      {
        ts: Date.now() - 59_000,
        kind: "plan_emitted",
        plan: {
          goal: "review the hybrid-retrieval PR",
          steps: [
            { rationale: "load the PR fixture", tool: "fetch_pr", input: { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 } },
          ],
        },
        version: 0,
      },
      {
        ts: Date.now() - 58_000,
        kind: "step_started",
        step: { rationale: "load the PR fixture", tool: "fetch_pr", input: { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 } },
        index: 0,
      },
      {
        ts: Date.now() - 57_000,
        kind: "observation",
        observation: {
          step: { rationale: "load the PR fixture", tool: "fetch_pr", input: {} },
          outcome: { kind: "ok", value: { pr: { title: "feat: hybrid retrieval" } } },
          cost: { input_tokens: 1200, output_tokens: 300, dollars: 0.018 },
        },
      },
      {
        ts: Date.now() - 56_000,
        kind: "finalized",
        review: {
          summary: "Looks like a solid hybrid-retrieval implementation. RRF math is correct; one nit about chunk-id collision handling.",
          findings: [],
          recommendation: "approve_with_comments",
        },
      },
    ],
    review: {
      summary: "Looks like a solid hybrid-retrieval implementation. RRF math is correct; one nit about chunk-id collision handling.",
      findings: [],
      recommendation: "approve_with_comments",
    },
  };
  const sampleB: WriteRunInput = {
    run_id: "sample-aborted",
    pr: { owner: "jt-mchorse", repo: "vector-search-at-scale", number: 6 },
    events: [
      { ts: Date.now() - 600_000, kind: "run_started", pr: { owner: "jt-mchorse", repo: "vector-search-at-scale", number: 6 } },
      {
        ts: Date.now() - 599_000,
        kind: "plan_emitted",
        plan: { goal: "review terraform infra changes", steps: [{ rationale: "fetch", tool: "fetch_pr", input: {} }] },
        version: 0,
      },
      {
        ts: Date.now() - 598_000,
        kind: "step_started",
        step: { rationale: "fetch", tool: "fetch_pr", input: {} },
        index: 0,
      },
      {
        ts: Date.now() - 597_000,
        kind: "observation",
        observation: {
          step: { rationale: "fetch", tool: "fetch_pr", input: {} },
          outcome: {
            kind: "error",
            error: { name: "ToolError", message: "input validation failed", toolName: "fetch_pr", kind: "input_validation" } as never,
          },
        },
      },
      { ts: Date.now() - 596_000, kind: "re_plan_triggered", reason: { kind: "tool_error", toolName: "fetch_pr", error: { name: "ToolError", message: "input validation failed", toolName: "fetch_pr", kind: "input_validation" } as never } },
      { ts: Date.now() - 595_000, kind: "aborted", reason: "max_replans_exceeded:5" },
      {
        ts: Date.now() - 594_000,
        kind: "finalized",
        review: {
          summary: "Could not load the PR — input validation kept failing.",
          findings: [],
          recommendation: "request_changes",
        },
      },
    ],
    review: {
      summary: "Could not load the PR — input validation kept failing.",
      findings: [],
      recommendation: "request_changes",
    },
  };
  await store.writeRun(sampleA);
  await store.writeRun(sampleB);
}

async function main(): Promise<void> {
  const useMemory = process.argv.includes("--memory");
  const port = Number(process.env.PORT) || 8766;

  let store: TraceStore;
  if (useMemory) {
    const m = new MemoryStore();
    await maybeSeedMemoryStore(m);
    store = m;
    console.log("trace-server: started with MemoryStore (seeded with 2 sample runs)");
  } else {
    store = new PgStore();
    console.log("trace-server: started with PgStore");
  }

  // The static dir is the sibling of this file in src/ui after the
  // build, or relative to the source path when running via tsx.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = path.resolve(here, "..", "ui");
  const server = createTraceServer({ store, staticDir });
  server.listen(port, "127.0.0.1", () => {
    console.log(`trace-server: http://127.0.0.1:${port}/`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
