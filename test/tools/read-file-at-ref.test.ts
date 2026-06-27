import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileAtRefTool,
  reconstructAddedFileFromPatch,
} from "../../src/tools/read-file-at-ref.js";
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

describe("reconstructAddedFileFromPatch (#61)", () => {
  it("keeps an added content line whose text starts with ++", () => {
    // GitHub prefixes each added source line with a single `+`, so the source
    // line `++flagged` appears as `+++flagged` in the patch. The old
    // `+++`/`---` header guard dropped it; it must survive reconstruction.
    const patch = "@@ -0,0 +1,3 @@\n+alpha\n+++flagged\n+beta";
    expect(reconstructAddedFileFromPatch(patch)).toBe("alpha\n++flagged\nbeta");
  });

  it("keeps an added line whose text starts with -- (no false header skip)", () => {
    // Symmetric guard: a source line `--note` becomes `+--note` (added lines
    // always carry a single `+`), and must not be mistaken for a `---` header.
    const patch = "@@ -0,0 +1,2 @@\n+x\n+--note";
    expect(reconstructAddedFileFromPatch(patch)).toBe("x\n--note");
  });

  it("reconstructs a normal added file unchanged and skips the @@ hunk header", () => {
    const patch = "@@ -0,0 +1,2 @@\n+line one\n+line two";
    expect(reconstructAddedFileFromPatch(patch)).toBe("line one\nline two");
  });

  it("returns null for a null patch", () => {
    expect(reconstructAddedFileFromPatch(null)).toBeNull();
  });
});
