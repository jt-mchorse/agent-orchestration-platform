// eval-runner refuses a value flag with no value, an unknown flag and a bad
// --pr, before doing any work (#161). Measured on main: `--results-dir
// --comment --repo o/r --pr 1` exited 0, wrote to a directory named
// `--comment`, and posted nothing; a trailing `--results-dir` was a raw
// TypeError at exit 1; `--comments` (a typo) was silently ignored.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runCLI(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["tsx", path.join(REPO_ROOT, "src", "bin", "eval-runner.ts"), ...args],
      { cwd },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
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
    const r = await runCLI(
      work,
      "--results-dir",
      "--comment",
      "--repo",
      "o/r",
      "--pr",
      "1",
    );
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
    // An empty or whitespace-only value is as missing as none (#279): it joined
    // to the repo root and wrote eval-*.json into the checkout at exit 0.
    [["--results-dir", ""], "--results-dir needs a value"],
    [["--results-dir", "   "], "--results-dir needs a value"],
    [["--fixtures-dir", ""], "--fixtures-dir needs a value"],
    [["--repo", "", "--pr", "1"], "--repo needs a value"],
  ])(
    "%j is exit 2 with %s",
    async (args, message) => {
      const r = await runCLI(work, ...args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`::error::${message}`);
    },
    30_000,
  );

  it('--results-dir "" is refused and adds no eval-*.json to the repo root (#279)', async () => {
    const evalFiles = async (): Promise<string[]> =>
      (await readdir(REPO_ROOT))
        .filter((f) => /^eval-.*\.json$/.test(f))
        .sort();
    const before = await evalFiles();
    const r = await runCLI(work, "--dry-run", "--results-dir", "");
    expect(r.code).toBe(2);
    expect(await evalFiles()).toEqual(before);
  }, 30_000);
});

// `--help` was an unknown argument at exit 2, and no usage error printed the
// flags (#282), while `validate --help` (#188) and `trace-server --help` (#217)
// both print usage at exit 0. Measured on main: `--help` and `-h` each printed
// `::error::unknown argument: --help` and exited 2.
describe("eval-runner --help and usage text (#282)", () => {
  const FLAGS = [
    "--dry-run",
    "--comment",
    "--repo",
    "--pr",
    "--fixtures-dir",
    "--results-dir",
  ];

  it.each([["--help"], ["-h"]])(
    "%s prints the usage on stdout at exit 0 and runs nothing",
    async (flag) => {
      const results = path.join(work, "results");
      const r = await runCLI(work, flag, "--results-dir", results);
      expect(r.code).toBe(0);
      expect(r.stdout.startsWith("usage: eval-runner")).toBe(true);
      for (const f of FLAGS) expect(r.stdout).toContain(f);
      expect(r.stderr).toBe("");
      // No eval ran: no rendered markdown, no results file.
      expect(r.stdout).not.toContain("eval results:");
      expect(existsSync(results)).toBe(false);
    },
    30_000,
  );

  it("--help after a valid flag still wins over running the eval", async () => {
    const results = path.join(work, "results");
    const r = await runCLI(
      work,
      "--dry-run",
      "--results-dir",
      results,
      "--help",
    );
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("usage: eval-runner")).toBe(true);
    expect(existsSync(results)).toBe(false);
  }, 30_000);

  it.each([
    [["--bogus"], "unknown argument: --bogus"],
    [["--repo"], "--repo needs a value"],
    [["--pr", "abc"], "--pr must be a positive integer"],
  ])(
    "%j prints the error then the usage on stderr, exit 2, stdout empty",
    async (args, message) => {
      const r = await runCLI(work, ...args);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      const [first, ...rest] = r.stderr.split("\n");
      expect(first).toContain(`::error::${message}`);
      const usage = rest.join("\n");
      expect(usage.startsWith("usage: eval-runner")).toBe(true);
      for (const f of FLAGS) expect(usage).toContain(f);
    },
    30_000,
  );
});
