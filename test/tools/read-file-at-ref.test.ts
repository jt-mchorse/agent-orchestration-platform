import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

describe("read_file_at_ref searches all fixtures for an added entry (#91)", () => {
  it("reconstructs the added version even when a modified-status fixture is seen first", async () => {
    // A PR file's status is relative to its base; this tool matches fixtures on
    // pr.head === ref only, so the same file at the same head can be `modified`
    // vs one base and `added` vs another. The alphabetically-first fixture here
    // has it `modified`; the second has it `added` with a full add patch. Pre-fix
    // the loop hit `return null` on the modified match and threw not_found; the
    // fix `continue`s and finds the reconstructable added entry.
    const dir = await mkdtemp(path.join(tmpdir(), "arf-91-"));
    const modifiedFirst = {
      repo: "o/r",
      pr: { head: "ref1", base: "main" },
      files: [{ filename: "src/x.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-old\n+new" }],
    };
    const addedSecond = {
      repo: "o/r",
      pr: { head: "ref1", base: "develop" },
      files: [{ filename: "src/x.ts", status: "added", patch: "@@ -0,0 +1,2 @@\n+hello\n+world" }],
    };
    await writeFile(path.join(dir, "a-modified.json"), JSON.stringify(modifiedFirst));
    await writeFile(path.join(dir, "b-added.json"), JSON.stringify(addedSecond));
    try {
      const result = await readFileAtRefTool.run(
        { owner: "o", repo: "r", ref: "ref1", path: "src/x.ts" },
        { mode: "replay", fixturesDir: dir },
      );
      expect(result.source).toBe("patch_added");
      expect(result.content).toBe("hello\nworld");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still raises not_found when the file is only ever modified (never added)", async () => {
    // The fix must not turn an unreconstructable file into a false success: a
    // file that is `modified` in every matching fixture has no full-content patch
    // anywhere, so the tool must still report not_found after exhausting them.
    const dir = await mkdtemp(path.join(tmpdir(), "arf-91b-"));
    const onlyModified = {
      repo: "o/r",
      pr: { head: "ref1", base: "main" },
      files: [{ filename: "src/x.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-old\n+new" }],
    };
    await writeFile(path.join(dir, "only-modified.json"), JSON.stringify(onlyModified));
    try {
      await expect(
        readFileAtRefTool.run(
          { owner: "o", repo: "r", ref: "ref1", path: "src/x.ts" },
          { mode: "replay", fixturesDir: dir },
        ),
      ).rejects.toBeInstanceOf(ToolError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reconstructs from a later fixture when an earlier added entry has patch:null", async () => {
    // GitHub emits patch:null for binary/large added files. The alphabetically-
    // first fixture has the file `added` but with patch:null (unreconstructable);
    // the second has it `added` with a full patch. Pre-fix the null-patch match
    // short-circuited with `return null` and threw not_found; the fix `continue`s
    // to the reconstructable entry — the null-patch sibling of the #91 branch.
    const dir = await mkdtemp(path.join(tmpdir(), "arf-91c-"));
    const nullPatchFirst = {
      repo: "o/r",
      pr: { head: "ref1", base: "main" },
      files: [{ filename: "src/x.ts", status: "added", patch: null }],
    };
    const fullPatchSecond = {
      repo: "o/r",
      pr: { head: "ref1", base: "develop" },
      files: [{ filename: "src/x.ts", status: "added", patch: "@@ -0,0 +1,2 @@\n+hello\n+world" }],
    };
    await writeFile(path.join(dir, "a-binary.json"), JSON.stringify(nullPatchFirst));
    await writeFile(path.join(dir, "b-full.json"), JSON.stringify(fullPatchSecond));
    try {
      const result = await readFileAtRefTool.run(
        { owner: "o", repo: "r", ref: "ref1", path: "src/x.ts" },
        { mode: "replay", fixturesDir: dir },
      );
      expect(result.source).toBe("patch_added");
      expect(result.content).toBe("hello\nworld");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still raises not_found when every added entry has patch:null", async () => {
    // The fix must not fabricate success: if no matching fixture carries a
    // reconstructable patch, the tool still reports not_found after exhausting all.
    const dir = await mkdtemp(path.join(tmpdir(), "arf-91d-"));
    const onlyNullPatch = {
      repo: "o/r",
      pr: { head: "ref1", base: "main" },
      files: [{ filename: "src/x.ts", status: "added", patch: null }],
    };
    await writeFile(path.join(dir, "only-null.json"), JSON.stringify(onlyNullPatch));
    try {
      await expect(
        readFileAtRefTool.run(
          { owner: "o", repo: "r", ref: "ref1", path: "src/x.ts" },
          { mode: "replay", fixturesDir: dir },
        ),
      ).rejects.toBeInstanceOf(ToolError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

describe("read_file_at_ref (replay) — tolerates a malformed .json in the fixtures dir", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("skips an unparseable .json instead of crashing the whole run (#77, twin of #73)", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "read-file-at-ref-bad-"));
    // A corrupt/non-fixture .json sitting in the walked directory must not be
    // fatal — pre-fix the bare JSON.parse threw a SyntaxError that propagated as
    // a non-ToolError and crashed the whole agent run, even though the requested
    // file is reconstructable from a perfectly good sibling fixture.
    await writeFile(path.join(tmp, "broken.json"), "{ not valid json", "utf8");
    await writeFile(
      path.join(tmp, "valid.json"),
      JSON.stringify({
        repo: "jt-mchorse/x",
        pr: { head: "feature", base: "main" },
        files: [
          {
            filename: "new.txt",
            status: "added",
            patch: "@@ -0,0 +1 @@\n+hello world",
          },
        ],
      }),
      "utf8",
    );

    const result = await readFileAtRefTool.run(
      { owner: "jt-mchorse", repo: "x", ref: "feature", path: "new.txt" },
      { mode: "replay", fixturesDir: tmp },
    );

    expect(result.source).toBe("patch_added");
    expect(result.content).toBe("hello world");
  });
});
