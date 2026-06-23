import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchRepoTool } from "../../src/tools/search-repo.js";
import type { ToolContext } from "../../src/tools/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../fixtures/sample-prs");
const ctx: ToolContext = { mode: "replay", fixturesDir };

describe("search_repo (replay)", () => {
  it("finds substring matches across fixture patches", async () => {
    const result = await searchRepoTool.run(
      { owner: "jt-mchorse", repo: "vector-search-at-scale", query: "terraform", maxResults: 5 },
      ctx,
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => typeof m.filename === "string" && typeof m.lineHint === "string")).toBe(true);
  });

  it("returns empty matches for a query that doesn't match anything in the target fixture", async () => {
    const result = await searchRepoTool.run(
      { owner: "jt-mchorse", repo: "vector-search-at-scale", query: "zzzzzzzzunlikely", maxResults: 5 },
      ctx,
    );
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("respects maxResults and reports truncated=true when capped", async () => {
    const result = await searchRepoTool.run(
      { owner: "jt-mchorse", repo: "vector-search-at-scale", query: "terraform", maxResults: 1 },
      ctx,
    );
    expect(result.matches.length).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("reports truncated=false when maxResults exactly equals the match count", async () => {
    // First learn the true match count with plenty of headroom, then ask for
    // exactly that many. Pre-fix, the `>= maxResults` check declared truncation
    // the moment the buffer filled — even though nothing was withheld.
    const all = await searchRepoTool.run(
      { owner: "jt-mchorse", repo: "vector-search-at-scale", query: "terraform", maxResults: 50 },
      ctx,
    );
    expect(all.truncated).toBe(false);
    const n = all.matches.length;
    expect(n).toBeGreaterThan(1);

    const exact = await searchRepoTool.run(
      { owner: "jt-mchorse", repo: "vector-search-at-scale", query: "terraform", maxResults: n },
      ctx,
    );
    expect(exact.matches.length).toBe(n);
    expect(exact.truncated).toBe(false);
  });
});
