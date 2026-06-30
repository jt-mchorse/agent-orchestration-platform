import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheckTool } from "../../src/tools/run-check.js";
import { ToolError, type ToolContext } from "../../src/tools/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.resolve(here, "../../.tmp-run-check");
const fixturesDir = path.join(tmpRoot, "sample-prs");
const checksDir = path.join(tmpRoot, "checks");
const ctx: ToolContext = { mode: "replay", fixturesDir };

const OWNER = "jt-mchorse";
const REPO = "vector-search-at-scale";
const REF = "session/2026-05-14-1100-issue-01";

beforeAll(async () => {
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(checksDir, { recursive: true });
  const slug = `${OWNER}__${REPO}__${REF}`.replace(/[\\/]/g, "_");
  await writeFile(
    path.join(checksDir, `${slug}.json`),
    JSON.stringify(
      {
        owner: OWNER,
        repo: REPO,
        ref: REF,
        checks: [
          { name: "ci/fmt", status: "completed", conclusion: "success", detailsUrl: null },
          { name: "ci/validate", status: "completed", conclusion: "failure", detailsUrl: null },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("run_check (replay)", () => {
  it("loads all checks for a ref when checkName is omitted", async () => {
    const result = await runCheckTool.run({ owner: OWNER, repo: REPO, ref: REF }, ctx);
    expect(result.source).toBe("fixture");
    expect(result.checks.map((c) => c.name)).toEqual(["ci/fmt", "ci/validate"]);
  });

  it("filters to a single check when checkName is provided", async () => {
    const result = await runCheckTool.run(
      { owner: OWNER, repo: REPO, ref: REF, checkName: "ci/validate" },
      ctx,
    );
    expect(result.checks.length).toBe(1);
    expect(result.checks[0]?.conclusion).toBe("failure");
  });

  it("returns missing_fixture when no checks file exists", async () => {
    const result = await runCheckTool.run(
      { owner: OWNER, repo: REPO, ref: "no-such-ref" },
      ctx,
    );
    expect(result.source).toBe("missing_fixture");
    expect(result.checks).toEqual([]);
  });

  it("rejects a malformed .json with a ToolError (internal), not a raw SyntaxError (#79)", async () => {
    // A corrupt fixture at the deterministic checks path must surface as the
    // SAME `internal` ToolError a schema mismatch raises — NOT a raw SyntaxError,
    // which executor.ts re-raises as a whole-run crash (the twin of #73/#77).
    // Also NOT `missing_fixture`: readFile succeeds (the file is there), only the
    // content is corrupt. Pre-fix this threw a SyntaxError (not a ToolError), so
    // this assertion is an inverse safety net for the bare `JSON.parse(raw)`.
    const badRef = "session/2026-06-30-malformed";
    const slug = `${OWNER}__${REPO}__${badRef}`.replace(/[\\/]/g, "_");
    await writeFile(path.join(checksDir, `${slug}.json`), "{ not valid json", "utf8");

    const promise = runCheckTool.run({ owner: OWNER, repo: REPO, ref: badRef }, ctx);
    await expect(promise).rejects.toBeInstanceOf(ToolError);
    await expect(promise).rejects.toMatchObject({ toolName: "run_check", kind: "internal" });
    await expect(promise).rejects.toThrow(/is not valid JSON/);
  });
});
