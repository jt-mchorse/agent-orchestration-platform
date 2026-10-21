/**
 * The CLI approval prompt shows the operator the rendered comment, and the
 * use-case doc describes what the checkpoint does in replay mode (#250).
 *
 * `defaultFormat` printed `JSON.stringify(req.input)` for every tool, so the
 * operator approving `post_review_comment` saw the summary as an escaped
 * one-line JSON string and the findings as nested objects -- not the Markdown
 * `renderPreview` builds. And docs/use-case.md said the checkpoint was a no-op
 * in replay mode, while the registry (correctly) still asks for approval there.
 */
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createCliApprovalProvider } from "../src/agent/cli-approval.js";
import { postReviewCommentTool } from "../src/tools/post-review-comment.js";
import { ToolRegistry } from "../src/tools/registry.js";

const comment = {
  owner: "jt-mchorse",
  repo: "rag-production-kit",
  number: 9,
  summary: "Adds hybrid retrieval.\n\nSee the `k` constant.",
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

/** Run one approval through the real registry in replay mode; return the prompt text. */
async function promptFor(toolInput: unknown): Promise<{ prompt: string; kind: string | undefined }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let prompt = "";
  output.on("data", (c: Buffer) => (prompt += c.toString("utf8")));
  const reg = new ToolRegistry();
  reg.register(postReviewCommentTool);
  const run = reg.invoke("post_review_comment", toolInput, {
    mode: "replay",
    fixturesDir: "fixtures/sample-prs",
    approvals: createCliApprovalProvider({ input, output }),
  });
  input.write("n\n");
  const kind = await run.then(
    () => undefined,
    (e: { kind?: string }) => e.kind,
  );
  return { prompt, kind };
}

/** Strip the prompt's fixed 6-space indent so lines compare against the poster's output. */
const dedent = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/^ {6}/, ""))
    .join("\n");

describe("the approval prompt shows the rendered comment (#250)", () => {
  it("prints every line of the poster's own renderPreview", async () => {
    // The poster's replay output, so this compares against what would be posted.
    const { preview } = await postReviewCommentTool.run(comment, {
      mode: "replay",
      fixturesDir: "fixtures/sample-prs",
    });
    const { prompt } = await promptFor(comment);
    expect(dedent(prompt)).toContain(preview);
  });

  it("shows the summary as Markdown paragraphs, not an escaped JSON string", async () => {
    const { prompt } = await promptFor(comment);
    expect(prompt).not.toContain('"summary":');
    expect(prompt).not.toContain("\\n");
    expect(prompt).toContain("# Review: jt-mchorse/rag-production-kit#9");
    expect(prompt).toContain("## Findings");
    expect(prompt).toContain("**CONCERN** `src/retrieve.py:14-22`");
  });

  // Control: green before and after. The operator's "n" still denies.
  it("still denies on n", async () => {
    const { prompt, kind } = await promptFor(comment);
    expect(kind).toBe("approval_denied");
    expect(prompt).toContain("Approve? [y/N]: ");
  });

  // Control: other tools, and a post_review_comment input that does not parse
  // as a review comment (a direct caller can pass anything), keep the JSON.
  it("falls back to the JSON input preview for other tools and unparseable input", async () => {
    for (const toolName of ["noop_destructive", "post_review_comment"]) {
      let out = "";
      const output = new PassThrough();
      output.on("data", (c: Buffer) => (out += c.toString("utf8")));
      const input = new PassThrough();
      const provider = createCliApprovalProvider({ input, output });
      const decision = provider.requestApproval({ toolName, reason: "r", input: { owner: "a", x: 1 } });
      input.write("y\n");
      expect((await decision).approved).toBe(true);
      expect(out).toContain("Input:");
      expect(out).toContain('"owner": "a"');
    }
  });
});

describe("docs/use-case.md describes the replay-mode checkpoint (#250)", () => {
  const doc = readFileSync(new URL("../docs/use-case.md", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("does not claim the checkpoint is a no-op in replay mode", () => {
    expect(doc).not.toMatch(/checkpoint is a no-op/);
  });

  // The behaviour the doc now states: the prompt fires in replay mode.
  it("matches the registry: replay mode still asks for approval", async () => {
    const { prompt, kind } = await promptFor(comment);
    expect(prompt).toContain("Approval required for destructive tool: post_review_comment");
    expect(kind).toBe("approval_denied");
    expect(doc).toMatch(/checkpoint still fires there/);
  });
});
