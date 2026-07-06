import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { postReviewCommentTool } from "../src/tools/post-review-comment.js";

/**
 * Doc-lock: every `recommendation: "…"` literal shown in the README must be a
 * value the `post_review_comment` tool actually accepts (#93).
 *
 * The README's interactive-approval example passed the space-separated
 * `"approve with comments"`, but #63 had already switched the tool's input
 * enum to the underscored `"approve_with_comments"` (to match the canonical
 * `Review["recommendation"]` and every producer/consumer). The code + its
 * tests were fixed; the README example was not, so the documented HITL
 * snippet threw `input_validation` on copy-paste before reaching the approval
 * gate it exists to demonstrate — and nothing caught it because no test
 * executes the README's TS blocks.
 *
 * This pins the README literal against the live schema (source of truth =
 * `postReviewCommentTool.inputSchema`), so the doc can't silently drift from
 * the enum again.
 */

const ROOT = resolve(__dirname, "..");
const README_PATH = resolve(ROOT, "README.md");

function readmeRecommendationLiterals(): string[] {
  const md = readFileSync(README_PATH, "utf-8");
  // Matches `recommendation: "…"` as written in the README's TS code blocks.
  const out: string[] = [];
  for (const m of md.matchAll(/recommendation:\s*"([^"]*)"/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function validRecommendations(): readonly string[] {
  // zod ZodEnum exposes `.options`; the tool's inputSchema is the single
  // source of truth the registry validates against.
  const shape = (
    postReviewCommentTool.inputSchema as unknown as {
      shape: { recommendation: { options: readonly string[] } };
    }
  ).shape;
  return shape.recommendation.options;
}

describe("README recommendation examples match the post_review_comment enum (#93)", () => {
  it("finds at least one documented recommendation value", () => {
    // Guards against the regex silently matching nothing (e.g. the README
    // block being renamed) and the lock becoming a no-op.
    expect(readmeRecommendationLiterals().length).toBeGreaterThan(0);
  });

  it("every README recommendation literal is a valid tool enum value", () => {
    const valid = new Set(validRecommendations());
    const invalid = readmeRecommendationLiterals().filter((v) => !valid.has(v));
    expect(
      invalid,
      `README uses recommendation value(s) not in the post_review_comment enum ` +
        `${JSON.stringify([...valid])}: ${JSON.stringify(invalid)}. ` +
        `Update the README example to a valid enum value.`,
    ).toEqual([]);
  });
});
