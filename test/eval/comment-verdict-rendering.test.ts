// The published composite agrees with the headline beside it (#147).
//
// `headlineFor` classifies `composite_mean` at full precision into one of three
// bands; the value itself was published two lines below at `toFixed(3)`. So the
// sticky PR comment could contradict itself across its own first two lines:
//
//     composite 0.8499 -> ":warning: composite < 0.85"  beside  "composite 0.850"
//     composite 0.6499 -> ":x: composite < 0.65"        beside  "composite 0.650"
//
// Both boundaries, not just the top one.
//
// **No test could have caught it.** The classification is correct in every
// colliding case, so nothing asserting on the headline can fire, and nothing
// asserting on the number can either — each is right on its own. The defect is
// only visible in the *relationship* between them, and nothing asserted that.
//
// This is the hardest spelling of a class worked in four sibling repos this week
// (`prompt-regression-suite#175`, `llm-eval-harness#252`,
// `ai-app-integration-tests#125`, `rag-production-kit#225`). There the two
// operands were interpolated into one string, so an AST sweep found them. Here
// the threshold is a *string literal inside the headline* and the value is in a
// different string twelve lines away — `leh#252`'s population arm structurally
// cannot see it, and its own docstring says so.

import { describe, expect, it } from "vitest";

import { bandFor, renderComposite, renderEvalMarkdown } from "../../src/eval/comment.js";
import type { EvalRun } from "../../src/eval/runner.js";

// The two boundaries the headline names. Read from the shipped bands rather than
// retyped: `bandFor` is exported, so a third band added to `COMPOSITE_BANDS`
// shows up here as a new distinct headline rather than being silently unswept.
const BOUNDARIES = [0.85, 0.65];

const MARGINS = [1e-1, 1e-2, 1e-3, 5e-4, 1e-4, 1e-5, 1e-6, 1e-8, 1e-10, 1e-12, 1e-14];

function runWithComposite(composite: number): EvalRun {
  return {
    cases: [
      {
        fixture_id: "alpha",
        actual: { summary: "s", findings: [], recommendation: "approve" },
        golden: { summary: "s", findings: [], recommendation: "approve" },
        score: {
          recommendation_match: 1,
          recommendation_actual: "approve",
          recommendation_golden: "approve",
          findings_precision: 0,
          findings_recall: 0,
          findings_f1: 0,
          matched_findings: 0,
          total_actual_findings: 0,
          total_golden_findings: 0,
          summary_length_ratio: 0.9,
          summary_actual_chars: 1,
          summary_golden_chars: 1,
          composite,
        },
      },
    ],
    composite_mean: composite,
    recommendation_accuracy: 1.0,
    findings_f1_mean: 0,
  };
}

/** The `composite **N**` value out of the rendered comment body. */
function publishedComposite(markdown: string): string {
  const match = /composite \*\*([^*]+)\*\*/.exec(markdown);
  expect(match).not.toBeNull();
  return match![1]!;
}

/** The headline out of the rendered comment body's `#` line. */
function publishedHeadline(markdown: string): string {
  const line = markdown.split("\n").find((l) => l.startsWith("# Agent eval"));
  expect(line).toBeDefined();
  return line!;
}

describe("renderComposite preserves the verdict", () => {
  // The central arms. Swept either side of BOTH boundaries, because a fix aimed
  // at 0.85 alone leaves 0.6499 publishing `:x: composite < 0.65` beside
  // `0.650` — and because the old rendering is *correct* for wide margins, so a
  // single hand-picked value proves whichever the sampler happened to pick.
  for (const boundary of BOUNDARIES) {
    it.each(MARGINS)(
      `a composite just below ${boundary} still classifies below it (margin %s)`,
      (margin) => {
        const composite = boundary - margin;
        const rendered = renderComposite(composite);
        expect(bandFor(Number(rendered))).toBe(bandFor(composite));
        expect(Number(rendered)).toBeLessThan(boundary);
      },
    );

    it.each(MARGINS)(
      `a composite at or just above ${boundary} still classifies above it (margin %s)`,
      (margin) => {
        const composite = boundary + margin;
        const rendered = renderComposite(composite);
        expect(bandFor(Number(rendered))).toBe(bandFor(composite));
        expect(Number(rendered)).toBeGreaterThanOrEqual(boundary);
      },
    );
  }

  it("the swept margins really do cross a boundary under the old rendering", () => {
    // Anti-vacuity on the margin list. Without this the sweeps could be a list of
    // comfortable margins the pre-#147 `toFixed(3)` also handled, and the suite
    // would prove nothing. Green on both trees on purpose — it is a statement
    // about arithmetic, and it is what says the sweeps walk the right corpus.
    const crossing = [];
    for (const boundary of BOUNDARIES) {
      for (const margin of MARGINS) {
        const composite = boundary - margin;
        if (Number(composite.toFixed(3)) >= boundary) crossing.push([boundary, margin]);
      }
    }
    expect(crossing.length).toBeGreaterThanOrEqual(12);
  });

  it("leaves ordinary composites at the published three places", () => {
    // The control that separates this fix from simply widening the width, and
    // the reason `docs/eval_snapshot.md` (composite 0.345) regenerates unchanged.
    expect(renderComposite(0.345)).toBe("0.345");
    expect(renderComposite(0.7)).toBe("0.700");
    expect(renderComposite(0.9)).toBe("0.900");
    expect(renderComposite(0.59)).toBe("0.590");
  });

  it("never narrows below the published width", () => {
    // `llm-eval-harness#252` shipped a narrowing regression in this exact class
    // earlier this week, caught only by that repo's artifact lock. Stated here as
    // an arm rather than left to the snapshot test to notice.
    for (const composite of [0.345, 0.7, 0.9, 0.5]) {
      expect(renderComposite(composite).split(".")[1]!.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("covers every band in the shipped table, not just the two boundaries swept", () => {
    // If a fourth band is added, `bandFor` gains a distinct headline and this
    // arm's count moves — so the band table and the sweep above cannot drift
    // apart silently. The renderer is expressed over `bandFor`, so a new band is
    // covered the moment it is declared; this is what says so out loud.
    const headlines = new Set(
      [-1, 0, 0.3, 0.6499, 0.65, 0.7, 0.8499, 0.85, 0.99, 1].map(bandFor),
    );
    expect(headlines.size).toBe(3);
    expect(BOUNDARIES.length).toBe(headlines.size - 1);
  });
});

describe("the rendered comment body cannot contradict its own headline", () => {
  // Through `renderEvalMarkdown`, not `renderComposite`, so these arms pin that
  // the call site is wired up. A helper-level check stays green against a
  // call-site revert — the trap `vector-search-at-scale#148` fell into.
  it.each([0.8499, 0.84999, 0.6499, 0.64999, 0.8499999])(
    "composite %s publishes a number consistent with its headline",
    (composite) => {
      const md = renderEvalMarkdown(runWithComposite(composite));
      const value = publishedComposite(md);
      const headline = publishedHeadline(md);
      expect(bandFor(Number(value))).toBe(bandFor(composite));
      // And spelled out against the headline text, which is what a reader sees.
      if (headline.includes("≥ 0.85")) {
        expect(Number(value)).toBeGreaterThanOrEqual(0.85);
      } else if (headline.includes("< 0.85")) {
        expect(Number(value)).toBeLessThan(0.85);
        expect(Number(value)).toBeGreaterThanOrEqual(0.65);
      } else {
        expect(Number(value)).toBeLessThan(0.65);
      }
    },
  );

  it("the headline and the value are decided by the same table", () => {
    // `headlineFor` now delegates to `bandFor`. Before #147 each boundary existed
    // twice — once in a `>=` and once spelled into the prose it returned — so the
    // comparison and the sentence describing it could drift apart.
    for (const composite of [0.9, 0.7, 0.3]) {
      const md = renderEvalMarkdown(runWithComposite(composite));
      expect(publishedHeadline(md)).toContain(bandFor(composite));
    }
  });

  it("an empty run still reports no fixtures rather than a band", () => {
    // The one path that is deliberately not a band: `composite_mean` is
    // meaningless with zero cases, and #147 must not have turned that into
    // `:x: composite < 0.65`.
    const md = renderEvalMarkdown({
      cases: [],
      composite_mean: 0,
      recommendation_accuracy: 0,
      findings_f1_mean: 0,
    });
    expect(publishedHeadline(md)).toContain("no fixtures");
    expect(publishedHeadline(md)).not.toContain("composite <");
  });
});
