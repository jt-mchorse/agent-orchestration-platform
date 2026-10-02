// A composite that is exactly 0.65 is 0.65 and gets its own band (#163).
//
// Measured on main: rec match + 1 of 9 golden findings + summaries 70:100 is
// exactly 0.5 + 0.4*0.2 + 0.1*0.7 = 0.65 and computed 0.6499999999999999, so
// the comment headline read ":x: composite < 0.65" above cells adding to 0.65;
// two rows of 0.575 and 0.725 averaged to the same 0.6499999999999999.
import { describe, expect, it } from "vitest";

import type { Finding, Review } from "../../src/agent/types.js";
import { bandFor, renderEvalMarkdown } from "../../src/eval/comment.js";
import { rational, toDouble } from "../../src/eval/exact.js";
import { compositeMean } from "../../src/eval/runner.js";
import { type ReviewScore, scoreReview } from "../../src/eval/score.js";

const hit = (i: number): Finding => ({ severity: "warning", message: `null deref in handler number ${i}`, file: `src/f${i}.ts` });
const miss: Finding = { severity: "info", message: "completely unrelated stylistic remark zzz", file: "other.md" };

function review(findings: Finding[], summaryChars: number): Review {
  return { summary: "x".repeat(summaryChars), findings, recommendation: "approve" };
}

function score(actual: Finding[], golden: Finding[], actualChars: number, goldenChars: number): ReviewScore {
  return scoreReview(review(actual, actualChars), review(golden, goldenChars));
}

const BELOW = bandFor(0.6499999999999999);
const AT = bandFor(0.65);

describe("exact composite (#163)", () => {
  it("rec match, 1 of 9 findings, summaries 70:100 is exactly 0.65", () => {
    const s = score([hit(0)], [0, 1, 2, 3, 4, 5, 6, 7, 8].map(hit), 70, 100);
    expect(s.matched_findings).toBe(1);
    expect(s.findings_f1).toBe(0.2);
    expect(s.composite).toBe(0.65);
    expect(bandFor(s.composite)).toBe(AT);
    expect(AT).not.toBe(BELOW);
  });

  it("a mean of 0.575 and 0.725 is exactly 0.65", () => {
    const a = score([miss], [hit(0)], 75, 100); // 0.5 + 0 + 0.1*0.75
    const b = score([hit(0)], [hit(0), hit(1), hit(2)], 25, 100); // 0.5 + 0.4*0.5 + 0.1*0.25
    expect([a.composite, b.composite]).toEqual([0.575, 0.725]);
    expect(compositeMean([a, b])).toBe(0.65);
  });

  it("the rendered comment does not put the failing headline over a 0.65 run", () => {
    const s = score([hit(0)], [0, 1, 2, 3, 4, 5, 6, 7, 8].map(hit), 70, 100);
    const actual = review([hit(0)], 70);
    const golden = review([0, 1, 2, 3, 4, 5, 6, 7, 8].map(hit), 100);
    const md = renderEvalMarkdown({
      cases: [{ fixture_id: "one", actual, golden, score: s }],
      composite_mean: compositeMean([s]),
      recommendation_accuracy: 1,
      findings_f1_mean: s.findings_f1,
    });
    expect(md).not.toContain(BELOW);
    expect(md).not.toContain("0.6499999999999999");
  });

  it("every small input's composite is the correctly rounded exact value", () => {
    let checked = 0;
    for (let m = 0; m <= 4; m++)
      for (let a = m; a <= 5; a++)
        for (let g = m; g <= 5; g++)
          for (const [x, y] of [[0, 0], [7, 10], [1, 3], [10, 10], [2, 9]] as const) {
            const actual = [...Array(m).keys()].map(hit).concat(Array(a - m).fill(miss));
            const golden = [...Array(m).keys()].map(hit).concat([...Array(g - m).keys()].map((i) => hit(100 + i)));
            const s = score(actual, golden, x, y);
            if (s.matched_findings !== m) continue; // the matcher, not the arithmetic, decided otherwise
            const f1 = a === 0 && g === 0 ? rational(1) : m === 0 ? rational(0) : rational(2 * m, a + g);
            const hi = Math.max(x, y);
            const ratio = hi === 0 ? rational(1) : rational(Math.min(x, y), hi);
            // 5/10 + (4/10)*f1 + (1/10)*ratio over one common denominator.
            const exact = rational(
              5n * f1.d * ratio.d + 4n * f1.n * ratio.d + ratio.n * f1.d,
              10n * f1.d * ratio.d,
            );
            expect(s.composite).toBe(toDouble(exact));
            checked++;
          }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("toDouble (#163)", () => {
  it("is exact division for small operands and correctly rounded for huge ones", () => {
    expect(toDouble(rational(13, 20))).toBe(0.65);
    expect(toDouble(rational(1, 3))).toBe(1 / 3);
    const big = 10n ** 30n;
    expect(toDouble(rational(13n * big, 20n * big + 1n))).toBe(0.65);
    expect(toDouble(rational(-2n * big, 3n * big))).toBe(-2 / 3);
  });
});
