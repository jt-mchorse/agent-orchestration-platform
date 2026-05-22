/**
 * Pins the `ToolError.kind` raised when any tool runs in `mode: "live"`.
 *
 * Before #21, the kind was `unsupported_in_replay` — the literal lied
 * about the trigger condition (it fired in LIVE mode, not replay). The
 * rename to `unsupported_in_live` makes the name match the trigger; this
 * test locks every tool that has a live-mode stub against the new kind,
 * and the companion public-surface guard locks the type literal itself.
 *
 * Live mode is stubbed for the five GitHub-shaped tools; #3's planner is
 * the seam that will wire a real GitHub client. Until then, every one
 * of them should fail with `unsupported_in_live` on `mode: "live"`.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPrTool } from "../../src/tools/fetch-pr.js";
import { readFileAtRefTool } from "../../src/tools/read-file-at-ref.js";
import { runCheckTool } from "../../src/tools/run-check.js";
import { searchRepoTool } from "../../src/tools/search-repo.js";
import { postReviewCommentTool } from "../../src/tools/post-review-comment.js";
import {
  autoApproveProvider,
} from "../../src/agent/cli-approval.js";
import { ToolError, type ToolContext } from "../../src/tools/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../fixtures/sample-prs");

const liveCtx: ToolContext = { mode: "live", fixturesDir };
const liveCtxWithApprovals: ToolContext = {
  mode: "live",
  fixturesDir,
  approvals: autoApproveProvider,
};

describe("live-mode error kind (#21)", () => {
  it("fetch_pr throws unsupported_in_live", async () => {
    try {
      await fetchPrTool.run(
        { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 },
        liveCtx,
      );
      expect.fail("expected fetch_pr to throw in live mode");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).kind).toBe("unsupported_in_live");
    }
  });

  it("read_file_at_ref throws unsupported_in_live", async () => {
    try {
      await readFileAtRefTool.run(
        {
          owner: "jt-mchorse",
          repo: "rag-production-kit",
          ref: "main",
          path: "src/retrieve.py",
        },
        liveCtx,
      );
      expect.fail("expected read_file_at_ref to throw in live mode");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).kind).toBe("unsupported_in_live");
    }
  });

  it("run_check throws unsupported_in_live", async () => {
    try {
      await runCheckTool.run(
        { owner: "jt-mchorse", repo: "rag-production-kit", ref: "main" },
        liveCtx,
      );
      expect.fail("expected run_check to throw in live mode");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).kind).toBe("unsupported_in_live");
    }
  });

  it("search_repo throws unsupported_in_live", async () => {
    try {
      await searchRepoTool.run(
        { owner: "jt-mchorse", repo: "rag-production-kit", query: "anything", maxResults: 5 },
        liveCtx,
      );
      expect.fail("expected search_repo to throw in live mode");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).kind).toBe("unsupported_in_live");
    }
  });

  it("post_review_comment throws unsupported_in_live after approval clears", async () => {
    // post_review_comment is destructive; its live-mode stub fires after
    // approval is granted, so we route through the registry-shaped ctx
    // that carries an auto-approve provider. The stub is what the kind
    // names, not the approval gate.
    try {
      await postReviewCommentTool.run(
        {
          owner: "jt-mchorse",
          repo: "rag-production-kit",
          number: 9,
          summary: "stub",
          findings: [],
          recommendation: "approve",
        },
        liveCtxWithApprovals,
      );
      expect.fail("expected post_review_comment to throw in live mode");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).kind).toBe("unsupported_in_live");
    }
  });
});
