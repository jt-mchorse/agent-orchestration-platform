/**
 * `run_check`'s replay fixture name is injective (#207).
 *
 * It was `${owner}__${repo}__${ref}` with `/` and `\` mapped to `_` -- the key
 * #201 replaced in `read_file_at_ref`, left here. `feature/x` and `feature_x`
 * were one file, so the two could not both be recorded, and a lookup for the
 * unrecorded one read the other's fixture and failed the coordinate check as
 * `internal` instead of returning `missing_fixture`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checksFixtureFile, runCheckTool } from "../../src/tools/run-check.js";
import type { ToolContext } from "../../src/tools/types.js";

const BACKSLASH = String.fromCharCode(92);
const PARTS = ["a", "a/b", `a${BACKSLASH}b`, "a_b", "a__b", "a+b", "a%2Fb", "_", "__"];

describe("checksFixtureFile (#207)", () => {
  it("gives every distinct input its own name", () => {
    const seen = new Map<string, string>();
    for (const owner of ["o", "o_x"]) {
      for (const repo of PARTS) {
        for (const ref of PARTS) {
          const input = JSON.stringify([owner, repo, ref]);
          const key = checksFixtureFile(owner, repo, ref);
          expect(seen.get(key), `${input} collides with ${seen.get(key)}`).toBeUndefined();
          seen.set(key, input);
        }
      }
    }
    expect(seen.size).toBe(2 * PARTS.length * PARTS.length);
  });

  it("splits the separator between components, not inside one", () => {
    expect(checksFixtureFile("o", "a__b", "c")).not.toBe(checksFixtureFile("o", "a", "b__c"));
    expect(checksFixtureFile("o", "a+b", "c")).not.toBe(checksFixtureFile("o", "a", "b+c"));
  });

  it("is a single file name", () => {
    for (const part of PARTS) {
      const key = checksFixtureFile("o", part, part);
      expect(key).not.toContain("/");
      expect(key).not.toContain(BACKSLASH);
      expect(path.basename(key)).toBe(key);
    }
  });
});

describe("run_check reads a fixture only for its own input (#207)", () => {
  const OWNER = "jt-mchorse";
  const REPO = "demo";
  let root = "";
  let ctx: ToolContext;

  const record = async (ref: string, check: string) =>
    writeFile(
      path.join(root, "checks", checksFixtureFile(OWNER, REPO, ref)),
      JSON.stringify({
        owner: OWNER,
        repo: REPO,
        ref,
        checks: [{ name: check, status: "completed", conclusion: "success", detailsUrl: null }],
      }),
      "utf8",
    );

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aop-207-"));
    await mkdir(path.join(root, "sample-prs"));
    await mkdir(path.join(root, "checks"));
    ctx = { mode: "replay", fixturesDir: path.join(root, "sample-prs") };
    await record("feature/x", "ci/slash");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("an unrecorded ref whose old key collided is missing_fixture, not internal", async () => {
    const out = await runCheckTool.run({ owner: OWNER, repo: REPO, ref: "feature_x" }, ctx);
    expect(out.source).toBe("missing_fixture");
    expect(out.checks).toEqual([]);
  });

  it("both refs can be recorded and each reads its own", async () => {
    await record("feature_x", "ci/underscore");
    const slash = await runCheckTool.run({ owner: OWNER, repo: REPO, ref: "feature/x" }, ctx);
    const under = await runCheckTool.run({ owner: OWNER, repo: REPO, ref: "feature_x" }, ctx);
    expect(slash.checks.map((c) => c.name)).toEqual(["ci/slash"]);
    expect(under.checks.map((c) => c.name)).toEqual(["ci/underscore"]);
  });
});
