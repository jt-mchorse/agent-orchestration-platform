/**
 * The eval score must not depend on the order findings were listed (#120).
 *
 * `matchFindings` sorted candidate pairs with `pairs.sort((p, q) => q.sim - p.sim)`
 * — score-descending, no tiebreak. `Array.prototype.sort` is stable, so ties
 * resolved to the nested-loop insertion order, i.e. the order the findings
 * appear in the two input arrays. The greedy 1:1 walk then consumed pairs in
 * that order, so which findings ended up matched depended on the listing.
 *
 * Measured on `main` @ fc0c55b — same three actuals, same three goldens,
 * distinct messages within each array, one severity throughout, with only
 * the GOLDEN order differing between the two rows:
 *
 *   A = [a / b / a b]
 *   G = [a b / a b c / a c d]  ->  2 matches, f1 0.6667, composite 0.8667
 *   G = [a b / a c d / a b c]  ->  3 matches, f1 1.0000, composite 1.0000
 *
 * A 0.133 swing, and one ordering reported a PERFECT score for the same review.
 *
 * The mechanism needs a tie at the top of the sorted list: when `(A0,G1)` and
 * `(A0,G2)` score equally and `G1` is the only viable partner for some other
 * actual, taking `(A0,G1)` first strands that actual and taking `(A0,G2)` first
 * does not. Equal Jaccard values are ordinary — `tokenize` reduces each message
 * to a token `Set`, so a general finding, a specific one and a combined one
 * routinely tie against several goldens.
 *
 * Same class and same fix shape as chunking-strategies-lab#68 (tie-break on the
 * chunk's stable identity) and rag-production-kit#40 (tie-break on doc id).
 *
 * These are written as *property* tests over all permutations rather than as a
 * handful of examples, because permutation-invariance is the contract.
 */

import { describe, expect, it } from "vitest";
import type { Finding, Review } from "../../src/agent/types.js";
import { matchFindings, scoreReview } from "../../src/eval/score.js";

function f(message: string, severity: Finding["severity"] = "concern"): Finding {
  return { severity, message, file: "a.ts" };
}

function r(findings: Finding[]): Review {
  return { recommendation: "approve", summary: "the same summary either way", findings };
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += 1) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i] as T, ...p]);
  }
  return out;
}

/**
 * Every (actual-order, golden-order) pair, and the distinct scores each produced.
 *
 * Returns the *set* of observed values so a test can assert there is exactly
 * one — which is the property — and print all of them when there isn't.
 */
function scoresOverAllOrderings(actualMsgs: string[], goldenMsgs: string[]) {
  const matchCounts = new Set<number>();
  const f1s = new Set<string>();
  const composites = new Set<string>();
  for (const aa of permutations(actualMsgs.map((m) => f(m)))) {
    for (const gg of permutations(goldenMsgs.map((m) => f(m)))) {
      matchCounts.add(matchFindings(aa, gg).length);
      const s = scoreReview(r(aa), r(gg));
      f1s.add(s.findings_f1.toFixed(10));
      composites.add(s.composite.toFixed(10));
    }
  }
  return { matchCounts, f1s, composites, n: 36 };
}

// Configurations found by brute-forcing 3x3 distinct-message sets over a small
// token vocabulary and permuting both arrays. Not hand-tuned — several distinct
// configurations exhibit the same order dependence.
const ORDER_SENSITIVE_CASES: Array<{ actual: string[]; golden: string[] }> = [
  { actual: ["a", "b", "a b"], golden: ["a b", "a b c", "a c d"] },
  { actual: ["b", "a", "a b"], golden: ["a b", "a b c", "b c d"] },
  { actual: ["a", "b", "a b"], golden: ["a b", "a b c", "a c e"] },
  { actual: ["a c", "a b", "a"], golden: ["b", "a", "a"] },
];

describe("matchFindings is invariant under input ordering (#120)", () => {
  it.each(ORDER_SENSITIVE_CASES)(
    "A=[$actual] G=[$golden] scores identically across all 36 orderings",
    ({ actual, golden }) => {
      const { matchCounts, f1s, composites } = scoresOverAllOrderings(actual, golden);
      // Pre-fix each of these produced two different match counts depending on
      // the listing order. The assertion is on the SET size, so the failure
      // message shows every value observed.
      expect([...matchCounts]).toHaveLength(1);
      expect([...f1s]).toHaveLength(1);
      expect([...composites]).toHaveLength(1);
    },
  );

  it("the specific measured case no longer swings by 0.133 on the composite", () => {
    // Anchored to the two numbers from the issue rather than to the mechanism.
    // Only the GOLDEN order differs; the actuals are byte-identical.
    const actual = [f("a"), f("b"), f("a b")];
    const goldenOrderA = [f("a b"), f("a b c"), f("a c d")];
    const goldenOrderB = [f("a b"), f("a c d"), f("a b c")];

    const scoreA = scoreReview(r(actual), r(goldenOrderA));
    const scoreB = scoreReview(r(actual), r(goldenOrderB));

    // Pre-fix: 0.8667 and 1.0000 respectively.
    expect(scoreB.composite).toBeCloseTo(scoreA.composite, 10);
    expect(scoreB.findings_f1).toBeCloseTo(scoreA.findings_f1, 10);
    expect(matchFindings(actual, goldenOrderB).length).toBe(
      matchFindings(actual, goldenOrderA).length,
    );
  });

  it("reversing both arrays does not change the score", () => {
    // The cheapest invariant to state and the one a reader will reach for.
    for (const { actual, golden } of ORDER_SENSITIVE_CASES) {
      const A = actual.map((m) => f(m));
      const G = golden.map((m) => f(m));
      const forward = scoreReview(r(A), r(G));
      const reversed = scoreReview(r([...A].reverse()), r([...G].reverse()));
      expect(reversed.composite).toBeCloseTo(forward.composite, 10);
      expect(reversed.matched_findings).toBe(forward.matched_findings);
    }
  });
});

describe("what the tiebreak must not change (#120)", () => {
  it("returned indices still track the caller's array positions", () => {
    // The indices MUST follow the permutation — a caller uses them to look the
    // finding back up. It is the score that must not move. Getting this
    // backwards would be a worse bug than the one being fixed.
    const A = [f("null pointer dereference"), f("unbounded loop counter")];
    const G = [f("unbounded loop counter"), f("null pointer dereference")];
    const matches = matchFindings(A, G);
    expect(matches).toHaveLength(2);
    for (const m of matches) {
      const actual = A[m.actual_index] as Finding;
      const golden = G[m.golden_index] as Finding;
      // Each returned pair really is the pair at those positions.
      expect(actual.message).toBe(golden.message);
      expect(m.similarity).toBe(1);
    }
    // And the index pairs are crossed, as the input ordering demands.
    expect(matches.map((m) => [m.actual_index, m.golden_index]).sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("the severity lock is untouched", () => {
    // D-011's severity key. The tiebreak only reorders pairs that already
    // cleared both the severity check and the Jaccard threshold.
    const A = [f("identical text here", "blocker")];
    const G = [f("identical text here", "nit")];
    expect(matchFindings(A, G)).toEqual([]);
  });

  it("the greedy 1:1 constraint is untouched", () => {
    // One actual cannot claim two goldens, and vice versa — the double-counting
    // D-011 exists to prevent.
    const A = [f("same words repeated")];
    const G = [f("same words repeated"), f("same words repeated again")];
    const matches = matchFindings(A, G);
    expect(matches).toHaveLength(1);
    expect(new Set(matches.map((m) => m.actual_index)).size).toBe(1);
  });

  it("the Jaccard threshold is untouched", () => {
    // A pair below 0.30 is still not a candidate at all, so no tiebreak applies.
    const A = [f("completely unrelated wording")];
    const G = [f("nothing in common whatsoever")];
    expect(matchFindings(A, G)).toEqual([]);
  });

  it("descending similarity still dominates the tiebreak", () => {
    // The content key is the SECOND key. A strictly better pair must still be
    // taken first, otherwise the greedy stops being greedy.
    const A = [f("exact match text"), f("exact match")];
    const G = [f("exact match text")];
    const matches = matchFindings(A, G);
    expect(matches).toHaveLength(1);
    // The 1.0 pair wins over the partial one regardless of listing order.
    expect(matches[0]?.similarity).toBe(1);
    expect(matches[0]?.actual_index).toBe(0);

    const reversedMatches = matchFindings([...A].reverse(), G);
    expect(reversedMatches[0]?.similarity).toBe(1);
    expect(reversedMatches[0]?.actual_index).toBe(1);
  });
});
