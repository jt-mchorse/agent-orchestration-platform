/**
 * `eval --comment` checks its own inputs before the eval, and its GitHub calls
 * are bounded (#173).
 *
 * The target was checked only after every fixture ran and the results file was
 * written; a missing token surfaced from inside `upsertStickyComment` as a
 * stack trace at exit 1 (the crash code); and the GitHub fetches had no
 * `signal`, so a server that accepted and never answered hung the step.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveToken, upsertStickyComment, STICKY_MARKER, TOKEN_ENV_NAMES } from "../src/eval/comment.js";

const ROOT = path.resolve(__dirname, "..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "aop-comment-preflight-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runEval(args: string[], dir: string) {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return spawnSync("npx", ["tsx", "src/bin/eval-runner.ts", "--comment", "--results-dir", dir, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("eval --comment preflight (#173)", () => {
  it("a missing target exits 2 before any fixture runs or any results file is written", () => {
    const dir = path.join(scratch, "no-target");
    const r = runEval([], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("::error::--comment requires --repo owner/name and --pr <n>");
    expect(r.stdout).not.toContain("eval results:");
    expect(() => readdirSync(dir)).toThrow(); // never created
  }, 130_000);

  it("a missing token exits 2 with one ::error:: line, not a stack trace at exit 1", () => {
    const dir = path.join(scratch, "no-token");
    const r = runEval(["--repo", "a/b", "--pr", "1"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("::error::GitHub token missing");
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stdout).not.toContain("eval results:");
    // The hint names the step a workflow is missing (#219).
    expect(r.stderr).toContain("env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  }, 130_000);
});

describe("the missing-token hint (#219)", () => {
  // `permissions: pull-requests: write` only scopes the job token; a `run:`
  // step sees it only through an `env:` mapping, as `.github/workflows/eval.yml`
  // does. The old hint said the permission alone "makes this automatic", so an
  // operator who followed it got this same error back.
  function missingTokenMessage(): string {
    const saved = TOKEN_ENV_NAMES.map((n) => [n, process.env[n]] as const);
    for (const [n] of saved) delete process.env[n];
    try {
      resolveToken({});
    } catch (e) {
      return (e as Error).message;
    } finally {
      for (const [n, v] of saved) if (v !== undefined) process.env[n] = v;
    }
    throw new Error("resolveToken did not throw with no token set");
  }

  it("names the env mapping that puts the token into a run: step", () => {
    expect(missingTokenMessage()).toContain("env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("does not claim the permissions block alone makes the token available", () => {
    expect(missingTokenMessage()).not.toMatch(/automatic/i);
  });

  it("matches the mapping the repo's own eval workflow uses", () => {
    const wf = readFileSync(path.join(ROOT, ".github", "workflows", "eval.yml"), "utf8");
    expect(wf).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(wf).toContain("pull-requests: write");
    expect(missingTokenMessage()).toContain("permissions: pull-requests: write");
  });
});

describe("GitHub calls are bounded (#173)", () => {
  it("a server that accepts and never answers is a timeout, not a hang", async () => {
    const held: ServerResponse[] = [];
    const server = createServer((_req, res) => {
      held.push(res); // never respond
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const started = Date.now();
    try {
      const err = await upsertStickyComment("a/b", 1, `${STICKY_MARKER}\nbody`, {
        apiBase: base,
        token: "ghp_test",
        timeoutMs: 300,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toMatch(/TimeoutError|AbortError/);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      for (const res of held) res.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
