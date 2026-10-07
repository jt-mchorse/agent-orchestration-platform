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
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { upsertStickyComment, STICKY_MARKER } from "../src/eval/comment.js";

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
  }, 130_000);
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
