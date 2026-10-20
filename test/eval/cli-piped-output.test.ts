// Piped-output tests for `src/bin/validate.ts` and `src/bin/eval-runner.ts`
// (#243).
//
// Both bins wrote their report and then called `process.exit(code)`. On macOS
// and Windows a write to a pipe is asynchronous, so the process ended before
// the buffer drained and everything past 64 KiB was lost: `validate --json |
// jq` got invalid JSON beside a normal exit 1, human mode lost the tail of its
// stderr findings, and a piped `eval --dry-run` lost the end of its table and
// the `eval results:` line. `spawn` reads the child through pipes, the shape a
// machine consumer uses. The small-output cases are controls: they were green
// before the fix, because a write under the pipe buffer size completes at once.
//
// On Linux, pipe writes are synchronous and these pass either way. They guard
// macOS and Windows, where the bug was reproduced.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SAMPLE = path.join(REPO_ROOT, "fixtures", "sample-prs", "rag-production-kit_pr9_hybrid_retrieval");
const PIPE_BUFFER = 64 * 1024;
const T = 60_000;

interface CLIResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runBin(bin: string, ...args: string[]): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", path.join("src", "bin", bin), ...args], { cwd: REPO_ROOT });
    // Buffers, joined once at the end: a chunk boundary can split a UTF-8
    // character (the eval table has a `✓`).
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      }),
    );
    child.on("error", reject);
  });
}

let dir: string;

/** The committed fixture with `n` files whose `status` is invalid: one finding each. */
async function copiedFixture(n: number): Promise<string> {
  const fixture = JSON.parse(await readFile(`${SAMPLE}.json`, "utf-8"));
  const base = fixture.files[0];
  fixture.files = Array.from({ length: n }, (_, i) => ({ ...base, filename: `f${i}.ts`, status: "copied" }));
  const p = path.join(dir, `copied-${n}.json`);
  await writeFile(p, JSON.stringify(fixture), "utf-8");
  return p;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aop-243-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("validate CLI output survives a pipe past 64 KiB (#243)", () => {
  it(
    "--json with 400 findings is complete, parseable JSON",
    async () => {
      const r = await runBin("validate.ts", await copiedFixture(400), "--json");
      expect(r.code).toBe(1);
      expect(r.stdout.length).toBeGreaterThan(PIPE_BUFFER);
      const report = JSON.parse(r.stdout);
      const statusFindings = report.findings.filter((f: { code: string }) => f.code.endsWith(".status_wrong_value"));
      expect(statusFindings).toHaveLength(400);
    },
    T,
  );

  it(
    "human mode with 1000 findings carries every finding line on stderr",
    async () => {
      const r = await runBin("validate.ts", await copiedFixture(1000));
      expect(r.code).toBe(1);
      expect(r.stderr.length).toBeGreaterThan(PIPE_BUFFER);
      expect(r.stderr.match(/\.status_wrong_value\] at /g)).toHaveLength(1000);
      expect(r.stderr.endsWith("\n")).toBe(true);
      expect(r.stdout).toMatch(/^fail: .* findings=\d+ schema_version=1\n$/);
    },
    T,
  );

  it(
    "control: --json with 3 findings parses (under the pipe buffer, green before #243)",
    async () => {
      const r = await runBin("validate.ts", await copiedFixture(3), "--json");
      expect(r.code).toBe(1);
      expect(r.stdout.length).toBeLessThan(PIPE_BUFFER);
      expect(JSON.parse(r.stdout).ok).toBe(false);
    },
    T,
  );

  it(
    "control: a clean fixture still exits 0 now that the code is set, not forced",
    async () => {
      const r = await runBin("validate.ts", `${SAMPLE}.json`, "--json");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).ok).toBe(true);
    },
    T,
  );
});

describe("eval-runner --dry-run output survives a pipe past 64 KiB (#243)", () => {
  /** A fixtures dir of `n` copies of the committed case, with long ids so the table is wide. */
  async function casesDir(n: number): Promise<string> {
    const d = await mkdtemp(path.join(dir, "cases-"));
    const fixture = await readFile(`${SAMPLE}.json`);
    const golden = await readFile(`${SAMPLE}.golden.json`);
    for (let i = 0; i < n; i += 1) {
      const stem = path.join(d, `${"c".repeat(180)}${String(i).padStart(4, "0")}`);
      await writeFile(`${stem}.json`, fixture);
      await writeFile(`${stem}.golden.json`, golden);
    }
    return d;
  }

  async function dryRun(n: number): Promise<CLIResult> {
    const results = await mkdtemp(path.join(dir, "results-"));
    return runBin("eval-runner.ts", "--dry-run", "--fixtures-dir", await casesDir(n), "--results-dir", results);
  }

  it(
    "400 cases: every table row and the trailing `eval results:` line arrive",
    async () => {
      const r = await dryRun(400);
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(PIPE_BUFFER);
      expect(r.stdout.match(/^\| `c+\d{4}` \|/gm)).toHaveLength(400);
      expect(r.stdout).toMatch(/\neval results: .*\.json\n$/);
    },
    T,
  );

  it(
    "control: 2 cases end with the `eval results:` line (under the pipe buffer, green before #243)",
    async () => {
      const r = await dryRun(2);
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBeLessThan(PIPE_BUFFER);
      expect(r.stdout).toMatch(/\neval results: .*\.json\n$/);
    },
    T,
  );
});
