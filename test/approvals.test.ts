import { Readable, Writable } from "node:stream";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import {
  type ApprovalProvider,
  type ApprovalRequest,
  type Tool,
  type ToolContext,
  ToolError,
} from "../src/tools/types.js";
import {
  autoApproveProvider,
  createCliApprovalProvider,
  denyAllProvider,
} from "../src/agent/cli-approval.js";
import { postReviewCommentTool } from "../src/tools/post-review-comment.js";
import { fetchPrTool } from "../src/tools/fetch-pr.js";

const ctxBase: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

const noOpDestructive: Tool<z.ZodObject<{ x: z.ZodNumber }>, z.ZodObject<{ x: z.ZodNumber }>> = {
  name: "noop_destructive",
  description: "test-only destructive tool that echoes its input",
  inputSchema: z.object({ x: z.number() }),
  outputSchema: z.object({ x: z.number() }),
  annotations: {
    destructive: true,
    destructiveReason: "exercise the approval flow in tests",
  },
  async run(input) {
    return { x: input.x };
  },
};

function trackingProvider(decision: { approved: boolean; reason?: string }) {
  const calls: ApprovalRequest[] = [];
  const provider: ApprovalProvider = {
    async requestApproval(req) {
      calls.push(req);
      return decision;
    },
  };
  return { provider, calls };
}

describe("registry approval flow for destructive tools", () => {
  it("rejects destructive invocation when ctx.approvals is missing", async () => {
    const reg = new ToolRegistry();
    reg.register(noOpDestructive);
    await expect(reg.invoke("noop_destructive", { x: 1 }, ctxBase)).rejects.toMatchObject({
      name: "ToolError",
      kind: "approval_missing",
    });
  });

  it("invokes the underlying tool when the approver returns approved=true", async () => {
    const reg = new ToolRegistry();
    reg.register(noOpDestructive);
    const { provider, calls } = trackingProvider({ approved: true });
    const result = await reg.invoke(
      "noop_destructive",
      { x: 7 },
      { ...ctxBase, approvals: provider },
    );
    expect(result).toEqual({ x: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("noop_destructive");
    expect(calls[0]?.reason).toBe("exercise the approval flow in tests");
    expect(calls[0]?.input).toEqual({ x: 7 });
  });

  it("rejects with approval_denied and propagates the operator's reason when approver denies", async () => {
    const reg = new ToolRegistry();
    reg.register(noOpDestructive);
    const { provider } = trackingProvider({ approved: false, reason: "operator said no" });
    await expect(
      reg.invoke("noop_destructive", { x: 1 }, { ...ctxBase, approvals: provider }),
    ).rejects.toMatchObject({
      name: "ToolError",
      kind: "approval_denied",
      message: expect.stringContaining("operator said no") as unknown as string,
    });
  });

  it("never calls the approver for non-destructive tools", async () => {
    const reg = new ToolRegistry();
    reg.register(fetchPrTool);
    const approver = vi.fn();
    await expect(
      reg.invoke(
        "fetch_pr",
        { owner: "jt-mchorse", repo: "ghost", number: 999 },
        { ...ctxBase, approvals: { requestApproval: approver } },
      ),
    ).rejects.toBeDefined();
    expect(approver).not.toHaveBeenCalled();
  });

  it("refuses to register a destructive tool that has no destructiveReason", () => {
    const reg = new ToolRegistry();
    const bad: Tool<z.ZodObject<Record<string, never>>, z.ZodObject<Record<string, never>>> = {
      name: "bad_tool",
      description: "missing reason",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      annotations: { destructive: true },
      async run() {
        return {};
      },
    };
    expect(() => reg.register(bad)).toThrow(/destructiveReason/);
  });

  it("lists destructive flag on each registered tool", () => {
    const reg = new ToolRegistry();
    reg.register(fetchPrTool);
    reg.register(postReviewCommentTool);
    const entries = reg.list();
    expect(entries.find((t) => t.name === "fetch_pr")?.destructive).toBe(false);
    expect(entries.find((t) => t.name === "post_review_comment")?.destructive).toBe(true);
  });
});

describe("post_review_comment destructive flow end-to-end", () => {
  const validInput = {
    owner: "jt-mchorse",
    repo: "rag-production-kit",
    number: 9,
    summary: "Adds hybrid retrieval with reasonable defaults.",
    findings: [
      {
        severity: "concern" as const,
        file: "src/retrieve.py",
        line_start: 14,
        line_end: 22,
        message: "RRF k constant deserves a comment.",
      },
    ],
    recommendation: "approve_with_comments" as const,
  };

  it("denyAllProvider blocks the post and the underlying tool is never invoked", async () => {
    const reg = new ToolRegistry();
    reg.register(postReviewCommentTool);
    const runSpy = vi.spyOn(postReviewCommentTool, "run");
    try {
      await expect(
        reg.invoke("post_review_comment", validInput, { ...ctxBase, approvals: denyAllProvider }),
      ).rejects.toThrow(ToolError);
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      runSpy.mockRestore();
    }
  });

  it("autoApproveProvider lets the tool render a preview in replay mode without 'posting'", async () => {
    const reg = new ToolRegistry();
    reg.register(postReviewCommentTool);
    const result = (await reg.invoke("post_review_comment", validInput, {
      ...ctxBase,
      approvals: autoApproveProvider,
    })) as { posted: boolean; mode: string; preview: string };
    expect(result.posted).toBe(false);
    expect(result.mode).toBe("replay");
    expect(result.preview).toMatch(/Review: jt-mchorse\/rag-production-kit#9/);
    expect(result.preview).toMatch(/CONCERN/);
    expect(result.preview).toMatch(/approve_with_comments/);
  });

  // #63: the input enum was space-separated while the canonical
  // Review["recommendation"] (and planner/eval/UI) use underscores, so the
  // HITL tool rejected the very Review it exists to post. Pin that every
  // canonical recommendation is accepted and echoed in the preview.
  it.each(["request_changes", "approve_with_comments", "approve"] as const)(
    "accepts the canonical Review recommendation %s and echoes it in the preview",
    async (recommendation) => {
      const reg = new ToolRegistry();
      reg.register(postReviewCommentTool);
      const result = (await reg.invoke(
        "post_review_comment",
        { ...validInput, recommendation },
        { ...ctxBase, approvals: autoApproveProvider },
      )) as { posted: boolean; preview: string };
      expect(result.posted).toBe(false);
      expect(result.preview).toContain(`**Recommendation:** ${recommendation}`);
    },
  );
});

describe("createCliApprovalProvider", () => {
  it("resolves approved=true when the operator types y", async () => {
    const inputStream = Readable.from(["y\n"]);
    const chunks: string[] = [];
    const outputStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const provider = createCliApprovalProvider({ input: inputStream, output: outputStream });
    const decision = await provider.requestApproval({
      toolName: "post_review_comment",
      reason: "post a comment",
      input: { owner: "a", repo: "b", number: 1 },
    });
    expect(decision.approved).toBe(true);
    expect(chunks.join("")).toMatch(/post_review_comment/);
    expect(chunks.join("")).toMatch(/Approve\? \[y\/N\]/);
  });

  it("resolves approved=false when the operator types n or just enter", async () => {
    const inputStream = Readable.from(["\n"]);
    const outputStream = new Writable({ write(_c, _e, cb) { cb(); } });
    const provider = createCliApprovalProvider({ input: inputStream, output: outputStream });
    const decision = await provider.requestApproval({
      toolName: "x",
      reason: "y",
      input: {},
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/operator answered/);
  });
});
