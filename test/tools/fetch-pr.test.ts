import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fetchPrTool } from "../../src/tools/fetch-pr.js";
import { ToolError, type ToolContext } from "../../src/tools/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../fixtures/sample-prs");
const ctx: ToolContext = { mode: "replay", fixturesDir };

describe("fetch_pr (replay)", () => {
  it("loads the vector-search-at-scale#6 fixture by coordinates", async () => {
    const result = await fetchPrTool.run(
      { owner: "jt-mchorse", repo: "vector-search-at-scale", number: 6 },
      ctx,
    );
    expect(result.repo).toBe("jt-mchorse/vector-search-at-scale");
    expect(result.pr.number).toBe(6);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.some((f) => f.filename.startsWith("terraform/"))).toBe(true);
  });

  it("loads the rag-production-kit#9 fixture by coordinates", async () => {
    const result = await fetchPrTool.run(
      { owner: "jt-mchorse", repo: "rag-production-kit", number: 9 },
      ctx,
    );
    expect(result.repo).toBe("jt-mchorse/rag-production-kit");
    expect(result.pr.number).toBe(9);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("raises not_found for unknown coordinates", async () => {
    await expect(
      fetchPrTool.run({ owner: "jt-mchorse", repo: "rag-production-kit", number: 9999 }, ctx),
    ).rejects.toBeInstanceOf(ToolError);
  });
});

describe("fetch_pr (replay) — tolerates a malformed .json in the fixtures dir", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("skips an unparseable .json instead of crashing the whole run (#81)", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "fetch-pr-bad-"));
    // A corrupt/non-fixture .json in the walked directory must not be fatal —
    // pre-fix the bare JSON.parse threw a raw SyntaxError (not a ToolError), so
    // the executor re-raised it and aborted the whole run. The corrupt file is
    // named to sort BEFORE the valid fixture in readdir order, so it is hit
    // first. Parity with search_repo's #73 guard.
    await writeFile(path.join(tmp, "aaa-broken.json"), "{ not valid json", "utf8");
    const validFixture = {
      schema_version: "1",
      source: "github",
      repo: "jt-mchorse/x",
      pr: {
        number: 9,
        title: "t",
        body: "b",
        state: "open",
        merged: false,
        base: "main",
        head: "feat",
        additions: 1,
        deletions: 0,
        changed_files: 1,
        html_url: "https://example.com/pr/9",
        created_at: "2026-01-01T00:00:00Z",
      },
      files: [
        { filename: "a.ts", status: "added", additions: 1, deletions: 0, changes: 1, patch: "+x" },
      ],
    };
    await writeFile(path.join(tmp, "zzz-valid.json"), JSON.stringify(validFixture), "utf8");

    const result = await fetchPrTool.run(
      { owner: "jt-mchorse", repo: "x", number: 9 },
      { mode: "replay", fixturesDir: tmp },
    );

    expect(result.repo).toBe("jt-mchorse/x");
    expect(result.pr.number).toBe(9);
  });
});
