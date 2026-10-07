/**
 * A golden with the wrong shape is skipped or refused, never a crash (#183).
 *
 * `discoverCases`' docstring promised "files whose golden lacks a
 * `golden_review` block are also skipped, with a warning logged to stderr",
 * and nothing did it. Measured on `main` with the shipped fixtures copied and
 * one golden edited:
 *   no golden_review          -> TypeError: Cannot read properties of undefined
 *                                (reading 'recommendation'), exit 1
 *   golden_review.summary null -> TypeError: Cannot read properties of null
 *                                (reading 'length'), exit 1
 * #115 closed the bad-JSON route into this crash; JSON that parses with the
 * wrong shape still reached `scoreReview`.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverCases, EvalInputError, evaluateAll } from "../../src/eval/runner";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SHIPPED = path.join(REPO_ROOT, "fixtures", "sample-prs");

let dir: string;
let edited: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aop-golden-shape-"));
  const names = await readdir(SHIPPED);
  for (const n of names) if (n.endsWith(".json")) await copyFile(path.join(SHIPPED, n), path.join(dir, n));
  edited = path.join(dir, names.filter((n) => n.endsWith(".golden.json")).sort()[0]!);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

const NO_REVIEW = JSON.stringify({ schema_version: "1", fixture_id: "x", provenance: "x" });
const NULL_SUMMARY = JSON.stringify({
  schema_version: "1",
  fixture_id: "x",
  provenance: "x",
  golden_review: { summary: null, recommendation: "approve", findings: [] },
});

describe("discoverCases skips a golden with no golden_review, as documented (#183)", () => {
  it("the case is left out", async () => {
    const before = (await discoverCases(dir)).length;
    await writeFile(edited, NO_REVIEW);
    expect((await discoverCases(dir)).length).toBe(before - 1);
  });

  it("an unparseable golden is NOT skipped: evaluateAll reports it", async () => {
    const before = (await discoverCases(dir)).length;
    await writeFile(edited, "{not json");
    expect((await discoverCases(dir)).length).toBe(before);
  });
});

describe("evaluateAll refuses a golden_review of the wrong shape (#183)", () => {
  it("a null summary is an EvalInputError naming the file and the field", async () => {
    await writeFile(edited, NULL_SUMMARY);
    const err = await evaluateAll(await discoverCases(dir)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalInputError);
    expect((err as Error).message).toContain(edited);
    expect((err as Error).message).toContain("golden_review.summary must be a string");
  });

  it("the shipped goldens still evaluate (control)", async () => {
    const run = await evaluateAll(await discoverCases(dir));
    expect(run.cases.length).toBeGreaterThan(0);
  });
});

describe("the CLI (#183)", () => {
  it("no golden_review: warns, evaluates the rest, exit 0", async () => {
    await writeFile(edited, NO_REVIEW);
    const r = await runCLI("--dry-run", "--fixtures-dir", dir);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: skipping .*no golden_review block/);
    expect(r.stderr).not.toContain("TypeError");
  }, 60_000);

  it("a null summary: one clean error line, exit 2", async () => {
    await writeFile(edited, NULL_SUMMARY);
    const r = await runCLI("--dry-run", "--fixtures-dir", dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid golden");
    expect(r.stderr).not.toContain("TypeError");
  }, 60_000);
});
