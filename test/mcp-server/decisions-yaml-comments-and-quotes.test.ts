/**
 * The decisions parser honours trailing comments and quoted values (#181).
 *
 * `parseScalar` and `parseList` read the raw text after the colon. The
 * portfolio's decision files use two YAML features that broke that:
 * - a trailing ` # comment` (`reversibility: cheap   # delete one call site`
 *   parsed as "unknown");
 * - quoted list items, which portfolio-ops D-010 now *requires*
 *   (`["#201", "#129"]   # quoted per ...` became ONE garbage element, and
 *   `["#211", ...]` kept its quotes).
 * Measured over the 13 repos' `core_decisions_ai.md`: 73 of 231 decisions
 * came back with a corrupted field before this fix, 0 after.
 */
import { describe, expect, it } from "vitest";

import { parseCoreDecisionsMarkdown } from "../../mcp-server/portfolio-context/decisions";

function one(body: string) {
  const ds = parseCoreDecisionsMarkdown(`- id: D-001\n${body}`);
  expect(ds).toHaveLength(1);
  return ds[0]!;
}

describe("trailing comments (#181)", () => {
  it("a comment after reversibility is not part of the value (llm-cost-optimizer D-015)", () => {
    expect(one("  reversibility: cheap   # delete one call site in SemanticCache.put\n").reversibility).toBe("cheap");
  });

  it("a comment after a quoted list is dropped (llm-cost-optimizer D-016)", () => {
    expect(one('  related_issues: ["#201", "#129"]   # quoted per portfolio-ops D-010\n').related_issues).toEqual([
      "#201",
      "#129",
    ]);
  });

  it("superseded_by: null with a comment is still active", () => {
    expect(one("  superseded_by: null  # still active\n").superseded_by).toBeNull();
  });

  it("a comment after a date is dropped", () => {
    expect(one("  date: 2026-10-07  # session date\n").date).toBe("2026-10-07");
  });

  it("legacy unquoted issue lists keep working: `#` inside brackets is not a comment", () => {
    expect(one("  related_issues: [#48, #50]\n").related_issues).toEqual(["#48", "#50"]);
    expect(one("  related_issues: [#48, #50]   # legacy\n").related_issues).toEqual(["#48", "#50"]);
  });

  it("prose keeps its `#`: decision and rationale are not comment-stripped", () => {
    const d = one("  decision: fixes #12 and #13 together\n  rationale: see #14\n");
    expect(d.decision).toBe("fixes #12 and #13 together");
    expect(d.rationale).toBe("see #14");
  });

  it("a `#` with no space before it is part of the value", () => {
    expect(one("  superseded_by: D-007#note\n").superseded_by).toBe("D-007#note");
  });
});

describe("quoted values (#181)", () => {
  it("quoted list items lose their quotes (llm-cost-optimizer D-017)", () => {
    expect(one('  related_issues: ["#211", "#205"]\n').related_issues).toEqual(["#211", "#205"]);
    expect(one("  related_issues: ['#211', '#205']\n").related_issues).toEqual(["#211", "#205"]);
  });

  it("a comma or a `#` inside quotes does not split or cut", () => {
    expect(one('  alternatives_rejected: ["a, b", "c # d"]  # two items\n').alternatives_rejected).toEqual([
      "a, b",
      "c # d",
    ]);
  });

  it("YAML escapes inside quotes are honoured", () => {
    expect(one('  alternatives_rejected: ["say \\"no\\"", \'it\'\'s\']\n').alternatives_rejected).toEqual([
      'say "no"',
      "it's",
    ]);
  });

  it("quoted scalars lose their quotes; a quoted \"null\" is the string", () => {
    const d = one('  reversibility: "cheap"\n  superseded_by: "D-009"\n  date: "2026-10-07"\n');
    expect(d.reversibility).toBe("cheap");
    expect(d.superseded_by).toBe("D-009");
    expect(d.date).toBe("2026-10-07");
    expect(one('  superseded_by: "null"\n').superseded_by).toBe("null");
  });

  it("unquoted values are unchanged (control)", () => {
    const d = one("  decision: use_pgvector\n  reversibility: one-way\n  related_issues: [11, 14]\n  superseded_by: null\n");
    expect(d.decision).toBe("use_pgvector");
    expect(d.reversibility).toBe("one-way");
    expect(d.related_issues).toEqual(["11", "14"]);
    expect(d.superseded_by).toBeNull();
  });
});
