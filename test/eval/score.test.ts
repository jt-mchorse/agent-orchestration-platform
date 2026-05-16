import { describe, expect, it } from "vitest";
import type { Finding, Review } from "../../src/agent/types.js";
import { jaccard, matchFindings, scoreReview } from "../../src/eval/score.js";

function r(
  recommendation: Review["recommendation"],
  summary: string,
  findings: Finding[] = [],
): Review {
  return { recommendation, summary, findings };
}

function f(
  severity: Finding["severity"],
  message: string,
  file?: string,
): Finding {
  return file !== undefined ? { severity, message, file } : { severity, message };
}

describe("jaccard", () => {
  it("returns 1 for two empty strings", () => {
    expect(jaccard("", "")).toBe(1);
  });

  it("returns 0 when one side is empty", () => {
    expect(jaccard("", "foo")).toBe(0);
    expect(jaccard("foo", "")).toBe(0);
  });

  it("returns 1 for identical inputs", () => {
    expect(jaccard("the quick brown fox", "the quick brown fox")).toBeCloseTo(1, 6);
  });

  it("computes proportion correctly", () => {
    // Two tokens each, one shared → 1 / (2 + 2 - 1) = 1/3
    expect(jaccard("foo bar", "foo baz")).toBeCloseTo(1 / 3, 6);
  });

  it("is case insensitive and ignores punctuation", () => {
    expect(jaccard("Hello, world!", "hello world")).toBeCloseTo(1, 6);
  });
});

describe("matchFindings", () => {
  it("matches by severity + token-overlap above threshold", () => {
    const matches = matchFindings(
      [f("blocker", "IAM role permission is too broad")],
      [f("blocker", "IAM role permission too broad on the load generator")],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ actual_index: 0, golden_index: 0 });
  });

  it("refuses to match across severities even with identical text", () => {
    const matches = matchFindings(
      [f("blocker", "exact same text")],
      [f("nit", "exact same text")],
    );
    expect(matches).toHaveLength(0);
  });

  it("greedy 1:1: each golden matches at most one actual", () => {
    const matches = matchFindings(
      [
        f("concern", "the same finding restated once"),
        f("concern", "the same finding restated twice"),
      ],
      [f("concern", "the same finding once")],
    );
    expect(matches).toHaveLength(1);
  });

  it("falls below threshold for unrelated text", () => {
    const matches = matchFindings(
      [f("blocker", "banana banana banana")],
      [f("blocker", "apple orange pear")],
    );
    expect(matches).toHaveLength(0);
  });
});

describe("scoreReview", () => {
  const goldenSummary = "a summary of the review with a few sentences and some structure";
  const goldenFindings = [
    f("blocker", "IAM role is overly permissive"),
    f("concern", "open security group ingress"),
  ];

  it("scores a perfectly-matching review at 1.0 composite", () => {
    const golden: Review = r("approve", goldenSummary, goldenFindings);
    const actual: Review = r("approve", goldenSummary, goldenFindings);
    const score = scoreReview(actual, golden);
    expect(score.composite).toBeCloseTo(1.0, 6);
    expect(score.recommendation_match).toBe(1);
    expect(score.findings_f1).toBeCloseTo(1.0, 6);
    expect(score.summary_length_ratio).toBeCloseTo(1.0, 6);
  });

  it("recommendation_match is exact-class", () => {
    const golden: Review = r("approve", goldenSummary);
    const wrong: Review = r("request_changes", goldenSummary);
    expect(scoreReview(wrong, golden).recommendation_match).toBe(0);
  });

  it("findings F1 is 0 when actual has no findings", () => {
    const golden: Review = r("approve", goldenSummary, goldenFindings);
    const actual: Review = r("approve", goldenSummary, []);
    const score = scoreReview(actual, golden);
    expect(score.findings_f1).toBe(0);
    expect(score.findings_precision).toBe(0);
    expect(score.findings_recall).toBe(0);
  });

  it("findings F1 captures partial matches", () => {
    const golden: Review = r("approve", goldenSummary, [
      f("blocker", "IAM role is overly permissive at *:*"),
      f("concern", "open security group ingress on the load generator"),
    ]);
    const actual: Review = r("approve", goldenSummary, [
      f("blocker", "the IAM role grants * permission"),
      f("nit", "missing cost disclosure in Makefile"),
    ]);
    const score = scoreReview(actual, golden);
    // One match (the blocker), one false positive (the nit), one false
    // negative (the unrelated concern).
    expect(score.matched_findings).toBe(1);
    expect(score.findings_precision).toBeCloseTo(0.5, 6);
    expect(score.findings_recall).toBeCloseTo(0.5, 6);
    expect(score.findings_f1).toBeCloseTo(0.5, 6);
  });

  it("summary_length_ratio handles both-empty edge case", () => {
    const a: Review = r("approve", "");
    const g: Review = r("approve", "");
    expect(scoreReview(a, g).summary_length_ratio).toBe(1);
  });

  it("composite weights recommendation > findings > summary", () => {
    // Get rec right (1.0), findings 0, summary 1.0: composite = 0.5 + 0 + 0.1 = 0.6
    const golden: Review = r("approve", goldenSummary, goldenFindings);
    const actual: Review = r("approve", goldenSummary, []);
    expect(scoreReview(actual, golden).composite).toBeCloseTo(0.6, 6);
  });
});
