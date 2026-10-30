/**
 * `post_review_comment` consumes the canonical `Review` as-is, findings
 * included (#292, the other half of #63).
 *
 * The canonical `Finding` is `{severity, message, file?, lineRange?}`, but the
 * tool's finding schema required `file` plus `line_start`/`line_end`. Nothing
 * maps one shape to the other, so every Review with a finding -- both committed
 * goldens among them -- failed `input_validation`, and only an empty Review
 * could reach the approval gate. #63 aligned the recommendation enum and its
 * round-trip test pinned only the recommendation (always with zero-finding or
 * hand-shaped input), so this went unseen.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { autoApproveProvider } from "../../src/agent/cli-approval.js";
import type { Finding, Review } from "../../src/agent/types.js";
import { postReviewCommentTool } from "../../src/tools/post-review-comment.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const ROOT = resolve(__dirname, "../..");
const FIXTURES_DIR = resolve(ROOT, "fixtures/sample-prs");
const PR = { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 };

async function post(review: unknown): Promise<string> {
  const reg = new ToolRegistry();
  reg.register(postReviewCommentTool);
  const out = (await reg.invoke(
    "post_review_comment",
    { ...PR, ...(review as object) },
    { mode: "replay", fixturesDir: "fixtures/sample-prs", approvals: autoApproveProvider },
  )) as { posted: boolean; preview: string };
  expect(out.posted).toBe(false);
  return out.preview;
}

async function rejectionOf(review: unknown): Promise<string | undefined> {
  return post(review).then(
    () => undefined,
    (e: { kind?: string }) => e.kind,
  );
}

const findingLines = (preview: string) => preview.split("\n").filter((l) => l.startsWith("- **"));

function goldenReviews(): [string, Review][] {
  return readdirSync(FIXTURES_DIR)
    .filter((n) => n.endsWith(".golden.json"))
    .sort()
    .map((n) => [n, JSON.parse(readFileSync(resolve(FIXTURES_DIR, n), "utf8")).golden_review as Review]);
}

describe("post_review_comment posts every committed golden Review (#292)", () => {
  const goldens = goldenReviews();

  // Guards the it.each below against an empty fixture directory.
  it("finds the committed goldens, and they carry findings", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(2);
    for (const [, review] of goldens) expect(review.findings.length).toBeGreaterThan(0);
  });

  it.each(goldens)("%s is accepted and every finding is rendered", async (_name, review) => {
    const preview = await post(review);
    const lines = findingLines(preview);
    expect(lines).toHaveLength(review.findings.length);
    review.findings.forEach((f, i) => {
      expect(lines[i]).toContain(`**${f.severity.toUpperCase()}**`);
      expect(lines[i]).toContain(f.message);
      if (f.file !== undefined) expect(lines[i]).toContain(`\`${f.file}\``);
    });
  });
});

describe("post_review_comment accepts each Finding shape the type admits (#292)", () => {
  const base = { summary: "s", recommendation: "approve_with_comments" as const };
  // Typed as the canonical Finding, so the test also fails to compile if the
  // type and the cases drift apart.
  const shapes: [string, Finding, string][] = [
    [
      "file + lineRange",
      { severity: "concern", message: "m", file: "src/a.py", lineRange: [14, 22] },
      "- **CONCERN** `src/a.py:14-22` — m",
    ],
    ["file only", { severity: "nit", message: "m", file: "src/a.py" }, "- **NIT** `src/a.py` — m"],
    ["lineRange only", { severity: "blocker", message: "m", lineRange: [3, 3] }, "- **BLOCKER** `lines 3-3` — m"],
    ["no anchor", { severity: "praise", message: "m" }, "- **PRAISE** — m"],
  ];

  it.each(shapes)("%s", async (_name, finding, expected) => {
    const review: Review = { ...base, findings: [finding] };
    expect(findingLines(await post(review))).toEqual([expected]);
  });

  // Control: green before and after.
  it("zero findings renders no Findings section", async () => {
    const preview = await post({ ...base, findings: [] });
    expect(preview).not.toContain("## Findings");
  });
});

describe("post_review_comment still refuses malformed findings (#292)", () => {
  const base = { summary: "s", recommendation: "approve" as const };
  const bad: [string, Record<string, unknown>][] = [
    ["start > end", { lineRange: [22, 14] }],
    ["line 0", { lineRange: [0, 4] }],
    ["non-integer line", { lineRange: [1.5, 4] }],
    ["one-element range", { lineRange: [4] }],
    ["empty file", { file: "" }],
    // The pre-#292 keys: refused, not silently stripped into an unanchored finding.
    ["legacy line_start/line_end", { file: "src/a.py", line_start: 14, line_end: 22 }],
  ];

  it.each(bad)("%s is input_validation", async (_name, extra) => {
    const kind = await rejectionOf({ ...base, findings: [{ severity: "nit", message: "m", ...extra }] });
    expect(kind).toBe("input_validation");
  });
});

describe("the README's post_review_comment example finding matches the schema (#292)", () => {
  const md = readFileSync(resolve(ROOT, "README.md"), "utf8");
  // The README block passes findings as a TS object literal; evaluate just
  // that array (plain data, no identifiers) and post it.
  const m = md.match(/"post_review_comment",\s*\{[\s\S]*?findings: (\[[\s\S]*?\]),\n\s*recommendation:/);

  it("finds the example and it posts with its anchor", async () => {
    expect(m, "README post_review_comment example not found").not.toBeNull();
    const findings = new Function(`return ${m![1]};`)() as Finding[];
    expect(findings.length).toBeGreaterThan(0);
    const lines = findingLines(await post({ summary: "s", recommendation: "approve", findings }));
    expect(lines).toHaveLength(findings.length);
    expect(lines[0]).toContain(`\`${findings[0]!.file}:${findings[0]!.lineRange![0]}-`);
  });
});
