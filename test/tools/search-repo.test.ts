import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

describe("search_repo (replay) — tolerates a malformed .json in the fixtures dir", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("skips an unparseable .json instead of crashing the whole search (#73)", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "search-repo-bad-"));
    // A corrupt/non-fixture .json sitting in the walked directory must not be
    // fatal — pre-fix the bare JSON.parse threw a SyntaxError and aborted the run.
    await writeFile(path.join(tmp, "broken.json"), "{ not valid json", "utf8");
    await writeFile(
      path.join(tmp, "valid.json"),
      JSON.stringify({
        repo: "jt-mchorse/x",
        files: [{ filename: "terraform/main.tf", patch: "+ terraform config" }],
      }),
      "utf8",
    );

    const result = await searchRepoTool.run(
      { owner: "jt-mchorse", repo: "x", query: "terraform", maxResults: 5 },
      { mode: "replay", fixturesDir: tmp },
    );

    expect(result.matches.map((m) => m.filename)).toContain("terraform/main.tf");
    expect(result.truncated).toBe(false);
  });
});
