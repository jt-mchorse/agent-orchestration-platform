/**
 * A fixture with the wrong shape is an operator error, never a crash (#190).
 *
 * #183 checked the golden half of each pair with `validateGolden` before any
 * field was read; the fixture half was still dereferenced unchecked by
 * `runAgentOnFixture`. Measured on `main` with the shipped pairs copied and
 * one fixture edited:
 *   repo removed      -> TypeError (reading 'split'), exit 1
 *   repo "noslash"    -> Error: fixture.repo must be 'owner/name', exit 1
 *   files removed     -> TypeError (reading 'slice'), exit 1
 *   pr null           -> TypeError (reading 'number'), exit 1
 * while `npm run validate` already reported every one of them.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverCases, EvalInputError, evaluateAll, runAgentOnFixture } from "../../src/eval/runner";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SHIPPED = path.join(REPO_ROOT, "fixtures", "sample-prs");

let dir: string;
let edited: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aop-fixture-shape-"));
  const names = await readdir(SHIPPED);
  for (const n of names) if (n.endsWith(".json")) await copyFile(path.join(SHIPPED, n), path.join(dir, n));
  const fixtures = names.filter((n) => n.endsWith(".json") && !n.endsWith(".golden.json")).sort();
  edited = path.join(dir, fixtures[0]!);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function editFixture(mutate: (o: Record<string, unknown>) => void): Promise<void> {
  const o = JSON.parse(await readFile(edited, "utf-8")) as Record<string, unknown>;
  mutate(o);
  await writeFile(edited, JSON.stringify(o));
}

function runCLI(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", path.join("src", "bin", "eval-runner.ts"), ...args], { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

const VARIANTS: Array<[string, (o: Record<string, unknown>) => void, string]> = [
  ["repo removed", (o) => delete o["repo"], "fixture must declare repo"],
  ["repo without a slash", (o) => (o["repo"] = "noslash"), `repo "noslash" must match 'owner/name'`],
  ["files removed", (o) => delete o["files"], "fixture must declare files"],
  ["pr null", (o) => (o["pr"] = null), "pr must be an object, got null"],
];

describe("runAgentOnFixture refuses a fixture of the wrong shape (#190)", () => {
  for (const [label, mutate, reason] of VARIANTS) {
    it(`${label}: an EvalInputError naming the file and the finding`, async () => {
      await editFixture(mutate);
      const err = await runAgentOnFixture(edited).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EvalInputError);
      expect((err as Error).message).toContain(`invalid fixture ${edited}`);
      expect((err as Error).message).toContain(reason);
      expect((err as Error).message).toContain(`npm run validate -- ${edited}\``);
    });
  }

  it("evaluateAll surfaces it as an EvalInputError too", async () => {
    await editFixture((o) => delete o["repo"]);
    const err = await evaluateAll(await discoverCases(dir)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalInputError);
  });

  it("the shipped fixtures still evaluate (control)", async () => {
    const run = await evaluateAll(await discoverCases(dir));
    expect(run.cases.length).toBeGreaterThan(0);
  });
});

describe("the CLI (#190)", () => {
  it("a fixture with no repo: one clean error line, exit 2, no stack", async () => {
    await editFixture((o) => delete o["repo"]);
    const r = await runCLI("--dry-run", "--fixtures-dir", dir, "--results-dir", path.join(dir, "results"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("::error::invalid fixture");
    expect(r.stderr).not.toContain("TypeError");
    expect(r.stderr).not.toMatch(/^\s+at /m);
  }, 60_000);
});
