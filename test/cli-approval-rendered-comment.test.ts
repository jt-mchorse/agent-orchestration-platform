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

/**
 * The rendered comment reaches the operator's terminal, and its text comes from
 * the planner's review of the PR, so a PR author can steer it (#257). Before
 * #253 the JSON dump escaped C0 controls; the rendered preview printed them
 * raw, so a CR + `ESC[2K` could erase the line the operator was approving.
 * Controls are built from codepoints.
 */
describe("the approval prompt escapes terminal control characters (#257)", () => {
  const ESC = String.fromCharCode(0x1b);
  const CR = String.fromCharCode(0x0d);
  const BEL = String.fromCharCode(0x07);
  const DEL = String.fromCharCode(0x7f);
  const CSI8 = String.fromCharCode(0x9b); // 8-bit CSI: JSON.stringify leaves it raw
  const RLO = String.fromCharCode(0x202e);
  const LRI = String.fromCharCode(0x2066);
  const TAB = String.fromCharCode(0x09);

  /** Every codepoint in `s` a terminal would act on, other than `\n`. */
  const rawControls = (s: string) =>
    [...s]
      .map((c) => c.codePointAt(0)!)
      .filter(
        (c) =>
          (c < 0x20 && c !== 0x0a) ||
          (c >= 0x7f && c <= 0x9f) ||
          (c >= 0x202a && c <= 0x202e) ||
          (c >= 0x2066 && c <= 0x2069),
      );

  const hostile = {
    ...comment,
    summary: `LGTM, ship it.${CR}${ESC}[2KMalicious hidden text${BEL}`,
    findings: [
      {
        ...comment.findings[0],
        file: `src/${RLO}yp.evil${LRI}`,
        message: `fine${ESC}[8m but hidden${DEL}${CSI8}1A`,
      },
    ],
  };

  it("prints no raw control codepoint from the summary, finding path or finding text", async () => {
    const { prompt } = await promptFor(hostile);
    expect(rawControls(prompt)).toEqual([]);
  });

  it("makes each one visible instead of dropping it", async () => {
    const { prompt } = await promptFor(hostile);
    expect(prompt).toContain("LGTM, ship it.\\r\\x1b[2KMalicious hidden text\\x07");
    expect(prompt).toContain("src/\\u202eyp.evil\\u2066");
    expect(prompt).toContain("fine\\x1b[8m but hidden\\x7f\\x9b1A");
  });

  // JSON.stringify escapes C0 but not C1 or bidi, so the fallback path is
  // sanitised too.
  it("escapes C1 and bidi in the JSON fallback preview", async () => {
    let out = "";
    const output = new PassThrough();
    output.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const input = new PassThrough();
    const decision = createCliApprovalProvider({ input, output }).requestApproval({
      toolName: "noop_destructive",
      reason: "r",
      input: { note: `a${CSI8}2K${RLO}b` },
    });
    input.write("n\n");
    await decision;
    expect(rawControls(out)).toEqual([]);
    expect(out).toContain('"note": "a\\x9b2K\\u202eb"');
  });

  // Control: green before and after. Multi-line text, tabs and ordinary
  // non-ASCII come through untouched.
  it("leaves plain multi-line text, tabs and non-ASCII unchanged", async () => {
    const plain = { ...comment, summary: `Line one.\n\nLine${TAB}two — naïve café.` };
    const { preview } = await postReviewCommentTool.run(plain, {
      mode: "replay",
      fixturesDir: "fixtures/sample-prs",
    });
    const { prompt } = await promptFor(plain);
    expect(dedent(prompt)).toContain(preview);
    expect(prompt).toContain(`Line${TAB}two — naïve café.`);
  });
});
