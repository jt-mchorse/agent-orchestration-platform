/**
 * The built eval-runner finds the repo's fixtures and results dirs (#275).
 *
 * `src/bin/eval-runner.ts` took the repo root as `here/../..`. That is right
 * for `src/bin/` under tsx and one level short for the built
 * `dist/src/bin/eval-runner.js`, whose root came out as `dist/`. Measured on
 * main 486679f: the built `--dry-run` exited 2 with `cannot read fixtures dir
 * <out>/fixtures/sample-prs: not found`, and with an absolute `--fixtures-dir`
 * it wrote `<out>/results/eval-*.json`. #269 made the built bins a supported
 * surface (the trace server's `here/../ui` is the right sibling in both
 * layouts, so it never had this bug).
 *
 * Both arms run with cwd set to the scratch outDir, so a fix that resolved the
 * defaults against cwd instead of the repo root fails here too.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildInto, REPO_ROOT } from "../helpers/build-into.js";

const TSX = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function dryRun(entry: string[], cwd: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [...entry, "--dry-run"], { cwd, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** The `eval results: <path>` line, checked to sit in `<repo>/results/`, then removed. */
function takeResult(out: string): string {
  const m = out.match(/^eval results: (.+)$/m);
  expect(m, out).not.toBeNull();
  const file = (m as RegExpMatchArray)[1] as string;
  expect(existsSync(file)).toBe(true);
  const dir = realpathSync(path.dirname(file));
  rmSync(file);
  return dir;
}

describe("eval-runner resolves fixtures/ and results/ at the repo root in both layouts (#275)", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(REPO_ROOT, ".tmp-build-"));
    buildInto(outDir);
  }, 120_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("the built dist/src/bin/eval-runner.js --dry-run exits 0 and writes to <repo>/results", () => {
    const r = dryRun([path.join(outDir, "src", "bin", "eval-runner.js")], outDir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Agent eval · [1-9]\d* fixture\(s\)/);
    expect(takeResult(r.out)).toBe(realpathSync(path.join(REPO_ROOT, "results")));
    expect(existsSync(path.join(outDir, "results"))).toBe(false);
  }, 60_000);

  it("the source src/bin/eval-runner.ts under tsx resolves the same dirs (control)", () => {
    const r = dryRun([TSX, path.join(REPO_ROOT, "src", "bin", "eval-runner.ts")], outDir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Agent eval · [1-9]\d* fixture\(s\)/);
    expect(takeResult(r.out)).toBe(realpathSync(path.join(REPO_ROOT, "results")));
    expect(existsSync(path.join(outDir, "results"))).toBe(false);
  }, 60_000);
});
