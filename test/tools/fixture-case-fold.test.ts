/**
 * A replay fixture is read only under its exact name (#249).
 *
 * The fixture names are distinct strings, but on a case-insensitive
 * filesystem (macOS APFS by default, Windows) `README.md`'s and `readme.md`'s
 * cache files are one file, while git paths and refs are case-sensitive. With
 * only `README.md` recorded, `read_file_at_ref` served its content labelled
 * `file_cache` for `readme.md`, and `run_check` threw `internal` for
 * `release/v1` against a recorded `release/V1`.
 *
 * Linux CI's filesystem is case-sensitive, so `readFile` is wrapped here to
 * fold case the way APFS does: these tests see the bug on any host.
 */
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  // A case-insensitive lookup: an exact miss opens a sibling whose name
  // differs only by case, as APFS does.
  const foldingReadFile = (async (file: unknown, options?: unknown) => {
    try {
      return await actual.readFile(file as string, options as "utf8");
    } catch (err) {
      if (typeof file !== "string") throw err;
      const dir = path.dirname(file);
      const want = path.basename(file).toLowerCase();
      const entries = await actual.readdir(dir).catch(() => [] as string[]);
      const hit = entries.find((e) => e.toLowerCase() === want);
      if (hit === undefined) throw err;
      return actual.readFile(path.join(dir, hit), options as "utf8");
    }
  }) as typeof actual.readFile;
  return { ...actual, readFile: foldingReadFile, default: { ...actual, readFile: foldingReadFile } };
});

import { cacheKeyFile, readFileAtRefTool } from "../../src/tools/read-file-at-ref.js";
import { checksFixtureFile, runCheckTool } from "../../src/tools/run-check.js";
import { ToolError, type ToolContext } from "../../src/tools/types.js";

const OWNER = "o";
const REPO = "r";
const REF = "main";

let root = "";
let ctx: ToolContext;

const cachePath = (filePath: string) => path.join(root, "file-cache", cacheKeyFile(OWNER, REPO, REF, filePath));

const recordChecks = async (nameRef: string, storedRef: string) =>
  writeFile(
    path.join(root, "checks", checksFixtureFile(OWNER, REPO, nameRef)),
    JSON.stringify({
      owner: OWNER,
      repo: REPO,
      ref: storedRef,
      checks: [{ name: "ci", status: "completed", conclusion: "success", detailsUrl: null }],
    }),
    "utf8",
  );

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aop-249-"));
  await mkdir(path.join(root, "sample-prs"));
  await mkdir(path.join(root, "file-cache"));
  await mkdir(path.join(root, "checks"));
  ctx = { mode: "replay", fixturesDir: path.join(root, "sample-prs") };
  await writeFile(cachePath("README.md"), "content of README.md\n", "utf8");
  await writeFile(
    path.join(root, "file-cache", cacheKeyFile(OWNER, REPO, "rel", "README.md")),
    "content of README.md\n",
    "utf8",
  );
  // At `main`, `readme.md` has no cache file but is added in a PR fixture.
  await writeFile(
    path.join(root, "sample-prs", "pr.json"),
    JSON.stringify({
      repo: `${OWNER}/${REPO}`,
      pr: { head: REF, base: "base" },
      files: [{ filename: "readme.md", status: "added", patch: "@@ -0,0 +1 @@\n+content of readme.md" }],
    }),
    "utf8",
  );
  await recordChecks("release/V1", "release/V1");
  // Recorded under its own exact name with the wrong coordinates inside.
  await recordChecks("misrecorded", "something-else");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the emulated filesystem folds case (#249)", () => {
  it("a plain readFile of readme.md's key opens README.md's cache file", async () => {
    expect(await readFile(cachePath("readme.md"), "utf8")).toBe("content of README.md\n");
  });
});

describe("read_file_at_ref reads a cache file only under its exact name (#249)", () => {
  it("serves the recorded file for its own path", async () => {
    const out = await readFileAtRefTool.run({ owner: OWNER, repo: REPO, ref: REF, path: "README.md" }, ctx);
    expect(out.source).toBe("file_cache");
    expect(out.content).toBe("content of README.md\n");
  });

  for (const folded of ["readme.md", "ReadMe.MD"]) {
    it(`${folded} is not_found, not README.md's content as file_cache`, async () => {
      // `rel` has no PR fixture, so only the cache could answer.
      const run = readFileAtRefTool.run({ owner: OWNER, repo: REPO, ref: "rel", path: folded }, ctx);
      await expect(run).rejects.toMatchObject({ toolName: "read_file_at_ref", kind: "not_found" });
    });
  }

  it("falls through to the path's own added-file patch", async () => {
    const out = await readFileAtRefTool.run({ owner: OWNER, repo: REPO, ref: REF, path: "readme.md" }, ctx);
    expect(out.source).toBe("patch_added");
    expect(out.content).toBe("content of readme.md\n");
  });
});

describe("run_check reads a fixture only under its exact name (#249)", () => {
  it("reads the recorded ref", async () => {
    const out = await runCheckTool.run({ owner: OWNER, repo: REPO, ref: "release/V1" }, ctx);
    expect(out.source).toBe("fixture");
    expect(out.checks.map((c) => c.name)).toEqual(["ci"]);
  });

  it("a case-folded ref is missing_fixture, not internal", async () => {
    const out = await runCheckTool.run({ owner: OWNER, repo: REPO, ref: "release/v1" }, ctx);
    expect(out.source).toBe("missing_fixture");
    expect(out.checks).toEqual([]);
  });

  it("a fixture under its exact name with the wrong coordinates is still internal", async () => {
    const run = runCheckTool.run({ owner: OWNER, repo: REPO, ref: "misrecorded" }, ctx);
    await expect(run).rejects.toMatchObject({ toolName: "run_check", kind: "internal" });
    await expect(run).rejects.toThrow(/coordinates do not match/);
  });
});
