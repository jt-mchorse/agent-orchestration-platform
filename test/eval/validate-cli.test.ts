// Spawn-based exit-code tests for `src/bin/validate.ts` (#188).
//
// The documented contract is 0 clean / 1 findings / 2 usage or I/O error.
// Before #188 an unknown flag or a second positional printed the usage and
// then returned `filePath === null ? 2 : 0` -- so beside a real path the CLI
// exited 0 ("clean") without validating anything, and an explicit `--help`
// exited 2. The failing-file baseline below is what makes the 0 meaningful:
// the same file, validated, is exit 1.
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
// A golden validated as a fixture: real findings, so exit 1 when it is read.
const FAILING = path.join("fixtures", "sample-prs", "rag-production-kit_pr9_hybrid_retrieval.golden.json");

interface CLIResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCLI(...args: string[]): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", path.join("src", "bin", "validate.ts"), ...args], {
      cwd: REPO_ROOT,
    });
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

const T = 30_000;

describe("validate CLI usage errors exit 2 without validating (#188)", () => {
  it(
    "baseline: the failing file, validated, exits 1",
    async () => {
      const r = await runCLI(FAILING);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("fail:");
    },
    T,
  );

  it(
    "an unknown flag beside a real path exits 2, not 0, and reads nothing",
    async () => {
      const r = await runCLI(FAILING, "--gloden");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unknown flag: --gloden");
      expect(r.stdout).toBe("");
    },
    T,
  );

  it(
    "a second positional exits 2, not 0, and reads nothing",
    async () => {
      const r = await runCLI(FAILING, "other.json");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unexpected positional argument: other.json");
      expect(r.stdout).toBe("");
    },
    T,
  );

  it(
    "an unknown flag still exits 2 when --help is also given",
    async () => {
      const r = await runCLI("--help", "--gloden");
      expect(r.code).toBe(2);
    },
    T,
  );

  it(
    "an explicit --help / -h prints the usage and exits 0",
    async () => {
      for (const flag of ["--help", "-h"]) {
        const r = await runCLI(flag);
        expect(r.code, flag).toBe(0);
        expect(r.stderr, flag).toContain("usage: validate");
      }
    },
    T,
  );

  it(
    "no path at all is still a usage error at exit 2",
    async () => {
      const r = await runCLI();
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("usage: validate");
    },
    T,
  );
});
