import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileAtRefTool } from "../../src/tools/read-file-at-ref.js";
import { ToolError, type ToolContext } from "../../src/tools/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../fixtures/sample-prs");
const ctx: ToolContext = { mode: "replay", fixturesDir };

describe("read_file_at_ref (replay)", () => {
  it("reconstructs an added file from a fixture patch", async () => {
    const result = await readFileAtRefTool.run(
      {
        owner: "jt-mchorse",
        repo: "rag-production-kit",
        ref: "session/2026-05-14-1430-issue-01",
        path: ".env.example",
      },
      ctx,
    );
    expect(result.source).toBe("patch_added");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("raises not_found when path is not in any fixture", async () => {
    await expect(
      readFileAtRefTool.run(
        {
          owner: "jt-mchorse",
          repo: "rag-production-kit",
          ref: "session/2026-05-14-1430-issue-01",
          path: "does/not/exist.ts",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("raises not_found when ref does not match any fixture head", async () => {
    await expect(
      readFileAtRefTool.run(
        {
          owner: "jt-mchorse",
          repo: "rag-production-kit",
          ref: "no-such-ref",
          path: ".env.example",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ToolError);
  });
});
