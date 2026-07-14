import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  commentTargetError,
  discoverCases,
  evaluateAll,
  runAgentOnFixture,
} from "../../src/eval/runner.js";

const FIXTURES_DIR = path.resolve(__dirname, "..", "..", "fixtures", "sample-prs");

describe("commentTargetError", () => {
  it("rejects a missing --repo or --pr", () => {
    expect(commentTargetError(null, 42)).toMatch(/requires --repo/);
    expect(commentTargetError("org/repo", null)).toMatch(/requires --repo/);
    expect(commentTargetError("", 42)).toMatch(/requires --repo/);
  });

  it("rejects a truthy-but-invalid --pr that would reach the GitHub API (#107)", () => {
    // Negative / non-finite / non-integer PR numbers are truthy, so a bare
    // falsy guard let them slip into `.../issues/${pr}/comments`. Each must now
    // fail up front with a clear message.
    for (const bad of [-5, Number.POSITIVE_INFINITY, 3.5, Number.NaN]) {
      const err = commentTargetError("org/repo", bad);
      expect(err, `--pr ${bad}`).toMatch(/--pr must be a positive integer/);
      expect(err, `--pr ${bad}`).toContain(String(bad));
    }
  });

  it("accepts a valid positive-integer --pr", () => {
    expect(commentTargetError("org/repo", 1)).toBeNull();
    expect(commentTargetError("org/repo", 42)).toBeNull();
  });

  it("rejects a truthy-but-malformed --repo that would reach the GitHub API (#109)", () => {
    // A non-empty slug that isn't `owner/name` (no slash, whitespace, extra
    // slash, empty owner/name) is truthy, so the presence check let it slip into
    // `.../repos/${repo}/issues/${pr}/comments`. Each must now fail up front with
    // the same `owner/name` contract the fixture-validation path enforces (#108
    // sibling).
    for (const bad of ["myrepo", "has space/x", "a/b/c", "/x", "org/"]) {
      const err = commentTargetError(bad, 5);
      expect(err, `--repo ${bad}`).toMatch(/--repo must match 'owner\/name'/);
      expect(err, `--repo ${bad}`).toContain(bad);
    }
  });

  it("accepts a valid owner/name --repo", () => {
    expect(commentTargetError("org/repo", 1)).toBeNull();
    expect(commentTargetError("my-org/my.repo", 7)).toBeNull();
  });
});

describe("discoverCases", () => {
  it("returns one case per fixture/golden pair under the directory", async () => {
    const cases = await discoverCases(FIXTURES_DIR);
    // Both committed fixtures have a sibling golden.
    expect(cases.length).toBeGreaterThanOrEqual(2);
    for (const c of cases) {
      expect(c.fixture_path.endsWith(".json")).toBe(true);
      expect(c.fixture_path.endsWith(".golden.json")).toBe(false);
      expect(c.golden_path.endsWith(".golden.json")).toBe(true);
    }
  });

  it("skips fixtures without a sibling golden", async () => {
    // Spot-check that SCHEMA.md (not a fixture) and the golden files
    // themselves don't appear as cases.
    const cases = await discoverCases(FIXTURES_DIR);
    for (const c of cases) {
      expect(c.fixture_id).not.toBe("SCHEMA");
      expect(c.fixture_id).not.toMatch(/\.golden$/);
    }
  });
});

describe("runAgentOnFixture", () => {
  it("produces a review against the rag-production-kit fixture", async () => {
    const fixture = path.join(
      FIXTURES_DIR,
      "rag-production-kit_pr9_hybrid_retrieval.json",
    );
    const review = await runAgentOnFixture(fixture);
    expect(typeof review.summary).toBe("string");
    expect(review.summary.length).toBeGreaterThan(0);
    expect(["request_changes", "approve_with_comments", "approve"]).toContain(
      review.recommendation,
    );
  });
});

describe("evaluateAll", () => {
  it("runs the agent against each case, scores it, aggregates", async () => {
    const cases = await discoverCases(FIXTURES_DIR);
    const run = await evaluateAll(cases);
    expect(run.cases.length).toBe(cases.length);
    expect(run.composite_mean).toBeGreaterThanOrEqual(0);
    expect(run.composite_mean).toBeLessThanOrEqual(1);
    expect(run.recommendation_accuracy).toBeGreaterThanOrEqual(0);
    expect(run.recommendation_accuracy).toBeLessThanOrEqual(1);
    expect(run.findings_f1_mean).toBeGreaterThanOrEqual(0);
    expect(run.findings_f1_mean).toBeLessThanOrEqual(1);
  });

  it("returns an empty run for empty input", async () => {
    const run = await evaluateAll([]);
    expect(run.cases).toEqual([]);
    expect(run.composite_mean).toBe(0);
    expect(run.recommendation_accuracy).toBe(0);
    expect(run.findings_f1_mean).toBe(0);
  });
});
