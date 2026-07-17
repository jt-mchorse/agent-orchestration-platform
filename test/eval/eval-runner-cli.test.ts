// Spawn-based CLI tests for `src/bin/eval-runner.ts`.
//
// The existing runner tests unit-test the pure functions (`commentTargetError`,
// `discoverCases`, `evaluateAll`) but never spawn the bin, so the exit-code
// plumbing was entirely untested — and that plumbing was broken: `main()`
// resolved the intended 0/1/2 code but the entrypoint never wired it to
// `process.exit`, so every non-zero signal was swallowed to exit 0 (#111).
// These tests pin the process-level exit-code contract (0/1/2 uniform with the
// sister `validate.ts` CLI, docs/architecture.md).
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface CLIResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCLI(...args: string[]): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", path.join("src", "bin", "eval-runner.ts"), ...args], {
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
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", reject);
  });
}

describe("eval-runner CLI exit-code contract (#111)", () => {
  let emptyDir: string;

  beforeEach(async () => {
    emptyDir = await mkdtemp(path.join(tmpdir(), "aop-eval-empty-"));
  });

  afterEach(async () => {
    await rm(emptyDir, { recursive: true, force: true });
  });

  it(
    "exits 2 (not 0) when the fixtures dir has no golden pairs",
    async () => {
      const r = await runCLI("--fixtures-dir", emptyDir);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no fixture/golden pairs found");
    },
    20_000,
  );

  it(
    "exits 2 with a clean message (no raw traceback) when the fixtures dir is missing",
    async () => {
      const missing = path.join(emptyDir, "does-not-exist");
      const r = await runCLI("--fixtures-dir", missing);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("cannot read fixtures dir");
      // Must be a clean operator-error line, not a leaked ENOENT stack trace.
      expect(r.stderr).not.toContain("at async discoverCases");
      expect(r.stderr).not.toMatch(/Error: ENOENT/);
    },
    20_000,
  );

  it(
    "exits 2 on a malformed --comment target (restores #108/#110 through the process boundary)",
    async () => {
      const r = await runCLI("--comment", "--repo", "badformat", "--pr", "5", "--fixtures-dir", emptyDir);
      expect(r.code).toBe(2);
    },
    20_000,
  );

  it(
    "exits 0 on a --dry-run against the committed fixtures",
    async () => {
      const r = await runCLI("--dry-run");
      expect(r.code).toBe(0);
    },
    20_000,
  );

  it(
    "exits 2 with a clean message (no raw traceback) when --results-dir is unwritable (#113)",
    async () => {
      // Write-seam sibling of #111: the fixtures read past, `atomicWriteFile` on
      // an operator `--results-dir` whose parent component is a FILE fails its
      // recursive mkdir with ENOTDIR. Runs against the committed fixtures
      // (--dry-run) so we reach the write; the write happens before the dry-run
      // return. Must be a clean exit-2 line, not a leaked ENOTDIR stack.
      const blocker = path.join(emptyDir, "afile");
      await writeFile(blocker, "not a dir", "utf-8");
      const r = await runCLI("--dry-run", "--results-dir", path.join(blocker, "sub"));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("cannot write results to");
      expect(r.stderr).not.toMatch(/at async (main|atomicWriteFile)/);
      expect(r.stderr).not.toMatch(/Error: ENOTDIR/);
    },
    20_000,
  );
});
