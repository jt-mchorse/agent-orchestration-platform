/**
 * The finding anchor in `post_review_comment`'s comment is one code span,
 * whatever the filename (#295).
 *
 * `renderPreview` wrapped the anchor in a fixed single-backtick span, and a PR
 * author controls filenames. Rendered with markdown-it 14 on the #294 branch:
 *   docs/`config`.md -> <code>docs/</code>config<code>.md:3-4</code>
 *   a`b.py           -> <code>a</code>b.py:3-4` (stray backtick)
 *   "a\n- **PRAISE** `fake.py` — looks great\nb.py"
 *                    -> two list items, a forged PRAISE among them
 * #244 fixed the same span in the eval comment (`codeSpanCell`); its fence
 * logic is now the shared `codeSpan` (src/markdown.ts). CR/LF in `file` is
 * refused: a code span cannot hold a line ending.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { autoApproveProvider } from "../../src/agent/cli-approval.js";
import { validateGolden } from "../../src/eval/validate.js";
import { codeSpan } from "../../src/markdown.js";
import { postReviewCommentTool } from "../../src/tools/post-review-comment.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const PR = { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 };

async function post(findings: unknown[]): Promise<string> {
  const reg = new ToolRegistry();
  reg.register(postReviewCommentTool);
  const out = (await reg.invoke(
    "post_review_comment",
    { ...PR, summary: "s", recommendation: "approve", findings },
    { mode: "replay", fixturesDir: "fixtures/sample-prs", approvals: autoApproveProvider },
  )) as { preview: string };
  return out.preview;
}

async function rejectionOf(findings: unknown[]): Promise<string | undefined> {
  return post(findings).then(
    () => undefined,
    (e: { kind?: string }) => e.kind,
  );
}

const findingLines = (preview: string) => preview.split("\n").filter((l) => l.startsWith("- **"));

// Reads a code span back the way CommonMark §6.1 does: an opening run of N
// backticks closes at the next run of EXACTLY N, and one leading+trailing space
// pair is stripped unless the body is all spaces. Returns the span's text and
// whatever follows it, or null when `s` does not start with a whole span.
function readCodeSpan(s: string): { text: string; rest: string } | null {
  const open = /^`+/.exec(s);
  if (!open) return null;
  const n = open[0].length;
  const after = s.slice(n);
  const m = new RegExp(`(?<!\`)\`{${n}}(?!\`)`).exec(after);
  if (!m) return null;
  let text = after.slice(0, m.index);
  if (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") {
    text = text.slice(1, -1);
  }
  return { text, rest: after.slice(m.index + n) };
}

/** The anchor a rendered finding line shows, and the text after the span. */
function anchorOf(line: string, severity: string): { text: string; rest: string } | null {
  const head = `- **${severity.toUpperCase()}** `;
  if (!line.startsWith(head)) return null;
  return readCodeSpan(line.slice(head.length));
}

describe("the finding anchor is one code span whatever the filename (#295)", () => {
  // Red against the single-backtick fence.
  it.each([
    ["a backtick pair", "docs/`config`.md"],
    ["a single backtick", "a`b.py"],
    ["a double-backtick run", "a``b`c.py"],
    ["a leading backtick", "`lead.py"],
  ])("%s", async (_label, file) => {
    const lines = findingLines(await post([{ severity: "blocker", message: "m", file, lineRange: [3, 4] }]));
    expect(lines).toHaveLength(1);
    expect(anchorOf(lines[0]!, "blocker")).toEqual({ text: `${file}:3-4`, rest: " — m" });
  });

  it("a file-only anchor ending in a backtick", async () => {
    const lines = findingLines(await post([{ severity: "nit", message: "m", file: "trail`" }]));
    expect(anchorOf(lines[0]!, "nit")).toEqual({ text: "trail`", rest: " — m" });
  });

  // Control: green before and after. A normal anchor is byte-identical.
  it("a plain anchor is unchanged", async () => {
    const lines = findingLines(
      await post([{ severity: "concern", message: "m", file: "src/retrieve.py", lineRange: [14, 22] }]),
    );
    expect(lines).toEqual(["- **CONCERN** `src/retrieve.py:14-22` — m"]);
  });
});

describe("CR and LF in a finding's file are refused (#295)", () => {
  const LF = String.fromCodePoint(10);
  const CR = String.fromCodePoint(13);
  const forged = `a${LF}- **PRAISE** \`fake.py\` — looks great${LF}b.py`;

  // Red on the #294 branch: accepted, and the LF case posted a forged item.
  it.each([
    ["the forged-item filename", forged],
    ["a bare LF", `a${LF}b.py`],
    ["a bare CR", `a${CR}b.py`],
    ["CRLF", `a${CR}${LF}b.py`],
  ])("%s is input_validation", async (_label, file) => {
    expect(await rejectionOf([{ severity: "blocker", message: "m", file, lineRange: [3, 4] }])).toBe(
      "input_validation",
    );
  });

  // The golden validator shares the schema (#294), so it refuses them too.
  it("validateGolden flags an LF in a golden finding's file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aop-anchor-"));
    try {
      const fixtures = path.join(__dirname, "..", "..", "fixtures", "sample-prs");
      const name = (await readdir(fixtures)).filter((n) => n.endsWith(".golden.json")).sort()[0]!;
      const golden = JSON.parse(await readFile(path.join(fixtures, name), "utf8"));
      golden.golden_review.findings[0].file = `a${LF}b.py`;
      const p = path.join(dir, name);
      await writeFile(p, JSON.stringify(golden));
      const r = await validateGolden(p);
      expect(r.findings.map((f) => f.jsonPath)).toEqual(["golden_review.findings[0].file"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Control: a tab is not a line ending and renders inside the span.
  it("a tab is accepted and shown verbatim", async () => {
    const TAB = String.fromCodePoint(9);
    const lines = findingLines(await post([{ severity: "nit", message: "m", file: `a${TAB}b.py` }]));
    expect(anchorOf(lines[0]!, "nit")).toEqual({ text: `a${TAB}b.py`, rest: " — m" });
  });
});

describe("codeSpan (#295)", () => {
  it.each(["plain", "a`b", "a``b`c", "`lead", "trail`", " spaced ", "|pipe|", "x"])(
    "%j reads back verbatim",
    (s) => {
      expect(readCodeSpan(codeSpan(s))).toEqual({ text: s, rest: "" });
    },
  );

  // CommonMark strips no padding from an all-space span, so none is added.
  it("an all-space value is not padded", () => {
    expect(codeSpan("  ")).toBe("`  `");
    expect(readCodeSpan(codeSpan("  "))).toEqual({ text: "  ", rest: "" });
  });
});
