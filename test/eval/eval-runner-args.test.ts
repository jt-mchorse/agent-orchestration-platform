// eval-runner refuses a value flag with no value, an unknown flag and a bad
// --pr, before doing any work (#161). Measured on main: `--results-dir
// --comment --repo o/r --pr 1` exited 0, wrote to a directory named
// `--comment`, and posted nothing; a trailing `--results-dir` was a raw
// TypeError at exit 1; `--comments` (a typo) was silently ignored.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runCLI(cwd: string, ...args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", path.join(REPO_ROOT, "src", "bin", "eval-runner.ts"), ...args], { cwd });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    child.on("error", reject);
  });
}

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "eval-args-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("eval-runner argument parsing (#161)", () => {
  it("a value flag followed by another flag is exit 2, and nothing is written", async () => {
    const results = path.join(work, "results");
    const r = await runCLI(work, "--results-dir", "--comment", "--repo", "o/r", "--pr", "1");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("::error::--results-dir needs a value");
    // The runner resolves a relative --results-dir against the REPO ROOT, so
    // that is where the swallowed flag's directory used to appear.
    expect(existsSync(path.join(REPO_ROOT, "--comment"))).toBe(false);
    expect(existsSync(results)).toBe(false);
  }, 30_000);

  it.each([
    [["--results-dir"], "--results-dir needs a value"],
    [["--comments"], "unknown argument: --comments"],
    [["--pr", "abc"], "--pr must be a positive integer"],
    [["--pr", "0"], "--pr must be a positive integer"],
    [["--repo"], "--repo needs a value"],
  ])("%j is exit 2 with %s", async (args, message) => {
    const r = await runCLI(work, ...args);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`::error::${message}`);
  }, 30_000);
});
