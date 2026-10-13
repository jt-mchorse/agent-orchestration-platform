/**
 * The replay cache key is injective (#201).
 *
 * It was `${owner}__${repo}__${ref}__${path}` with `/` and `\` mapped to `_`,
 * so `feature/x` and `feature_x`, or `src/a.py` and `src_a.py`, read one
 * cached file, and the wrong ref's or file's content came back labelled
 * `source: "file_cache"`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cacheKeyFile, readFileAtRefTool } from "../../src/tools/read-file-at-ref.js";
import { ToolError, type ToolContext } from "../../src/tools/types.js";

const BACKSLASH = String.fromCharCode(92);
const PARTS = ["a", "a/b", `a${BACKSLASH}b`, "a_b", "a__b", "a+b", "a%2Fb", "_", "__"];

describe("cacheKeyFile (#201)", () => {
  it("gives every distinct input its own name", () => {
    const seen = new Map<string, string>();
    for (const owner of ["o", "o_x"]) {
      for (const ref of PARTS) {
        for (const filePath of PARTS) {
          const input = JSON.stringify([owner, "r", ref, filePath]);
          const key = cacheKeyFile(owner, "r", ref, filePath);
          expect(seen.get(key), `${input} collides with ${seen.get(key)}`).toBeUndefined();
          seen.set(key, input);
        }
      }
    }
    expect(seen.size).toBe(2 * PARTS.length * PARTS.length);
  });

  it("splits the separator between components, not inside one", () => {
    expect(cacheKeyFile("a__b", "c", "r", "p")).not.toBe(cacheKeyFile("a", "b__c", "r", "p"));
    expect(cacheKeyFile("a+b", "c", "r", "p")).not.toBe(cacheKeyFile("a", "b+c", "r", "p"));
  });

  it("is a single file name", () => {
    for (const part of PARTS) {
      const key = cacheKeyFile("o", "r", part, part);
      expect(key).not.toContain("/");
      expect(key).not.toContain(BACKSLASH);
      expect(path.basename(key)).toBe(key);
    }
  });
});

describe("read_file_at_ref serves a cached file only for its own input (#201)", () => {
  let root = "";
  let ctx: ToolContext;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aop-201-"));
    const fixturesDir = path.join(root, "sample-prs");
    await mkdir(fixturesDir);
    await mkdir(path.join(root, "file-cache"));
    await writeFile(
      path.join(root, "file-cache", cacheKeyFile("jt-mchorse", "demo", "feature/x", "src/a.py")),
      "CONTENT OF src/a.py AT feature/x\n",
      "utf8",
    );
    ctx = { mode: "replay", fixturesDir };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves its own input", async () => {
    const out = await readFileAtRefTool.run(
      { owner: "jt-mchorse", repo: "demo", ref: "feature/x", path: "src/a.py" },
      ctx,
    );
    expect(out.source).toBe("file_cache");
    expect(out.content).toBe("CONTENT OF src/a.py AT feature/x\n");
  });

  it.each([
    ["another ref", "feature_x", "src/a.py"],
    ["another path", "feature/x", "src_a.py"],
  ])("does not serve %s", async (_label, ref, filePath) => {
    await expect(
      readFileAtRefTool.run({ owner: "jt-mchorse", repo: "demo", ref, path: filePath }, ctx),
    ).rejects.toBeInstanceOf(ToolError);
  });
});
