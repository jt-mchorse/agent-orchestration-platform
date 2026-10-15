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

describe("search_repo hint cap keeps surrogate pairs whole (#215)", () => {
  // `${raw.slice(0, 237)}...` counted UTF-16 code units, so an astral
  // character straddling the cut left a lone high surrogate in the hint.
  // PgStore persists the observation as jsonb, which refuses one, so the run
  // was lost there while MemoryStore kept it. Built from code points.
  const EMOJI = String.fromCodePoint(0x1f600);
  const LONE = /\p{Cs}/u;
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  async function hintFor(line: string): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "aop-215-"));
    await writeFile(
      path.join(dir, "pr.json"),
      JSON.stringify({ repo: "o/r", files: [{ filename: "a.txt", patch: `@@ -0,0 +1 @@\n${line}` }] }),
    );
    const out = await searchRepoTool.run(
      { owner: "o", repo: "r", query: "needle", maxResults: 20 },
      { mode: "replay", fixturesDir: dir },
    );
    const hint = out.matches[0]?.lineHint;
    if (hint === undefined) throw new Error("no match");
    return hint;
  }

  // The emoji's high half lands at code unit 232..238, around the 237 cut.
  it.each([231, 232, 233, 234, 235, 236, 237])(
    "an emoji after %i ASCII units leaves a well-formed hint of at most 240 units",
    async (pad) => {
      const line = `+${"x".repeat(pad)}${EMOJI}needle${"z".repeat(20)}`;
      const hint = await hintFor(line);
      expect(LONE.test(hint)).toBe(false);
      expect(hint.length).toBeLessThanOrEqual(240);
      expect(hint.endsWith("...")).toBe(true);
      // Nothing beyond the one split character is dropped.
      expect(line.startsWith(hint.slice(0, -3))).toBe(true);
      expect(hint.length).toBeGreaterThanOrEqual(239);
    },
  );

  it("a line of emoji is cut between pairs, not inside one", async () => {
    // 8 units of prefix put every pair's high half on an even index, 236 included.
    const hint = await hintFor(`+needle ${EMOJI.repeat(200)}`);
    expect(LONE.test(hint)).toBe(false);
    expect(hint.length).toBeLessThanOrEqual(240);
  });

  it("an all-ASCII line is cut exactly where it was", async () => {
    const line = `+needle${"a".repeat(300)}`;
    expect(await hintFor(line)).toBe(`${line.slice(0, 237)}...`);
  });
});
