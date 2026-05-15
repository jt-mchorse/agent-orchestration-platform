import { describe, expect, it } from "vitest";
import path from "node:path";
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
