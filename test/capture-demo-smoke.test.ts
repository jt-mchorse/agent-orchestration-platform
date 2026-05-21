/**
 * Smoke test for `scripts/capture_demo.sh` (issue #16).
 *
 * The capture script is the deterministic driver for the 60-second
 * README demo. JT records the GIF/video while it runs; CI runs it with
 * `CAPTURE_PACE_SECONDS=0` so the demo can't bitrot the same way
 * `readme-snapshot.test.ts` already protects the README numbers in
 * isolation.
 *
 * Contract this test pins:
 *
 * 1. The script exits 0 on a fresh clone with no API key and no
 *    Postgres.
 * 2. Each of the two surfaces actually runs (the surface header + the
 *    surface's distinctive output both appear).
 * 3. The eval step prints the sticky-comment marker that the GH Action
 *    uses to edit its comment in place, plus the composite table.
 * 4. The trace-server step boots MemoryStore (seeded with two synthetic
 *    runs) and the curl of `/api/runs` returns both seeded runs.
 *
 * The script's background trace-server is reaped via EXIT trap, so a
 * failed assertion here doesn't leave a port-holder behind.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "capture_demo.sh");

interface CaptureResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

let cached: CaptureResult | undefined;

function runCapture(): CaptureResult {
  if (cached !== undefined) return cached;
  if (!existsSync(SCRIPT)) {
    throw new Error(`missing ${SCRIPT}`);
  }
  const result = spawnSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CAPTURE_PACE_SECONDS: "0",
    },
    encoding: "utf8",
    // Capture-demo (with --memory trace server boot + npm overhead)
    // typically runs in <2s on a laptop. 60s cap is room for slower CI.
    timeout: 60_000,
  });
  cached = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
  return cached;
}

describe("scripts/capture_demo.sh (issue #16)", () => {
  it("exits 0 on a fresh clone with no API key and no Postgres", () => {
    const r = runCapture();
    expect(r.status, `stderr:\n${r.stderr}\n\nstdout (tail):\n${r.stdout.slice(-500)}`).toBe(0);
  });

  it("surface 1: eval --dry-run prints the sticky-comment marker + composite table", () => {
    const r = runCapture();
    expect(r.stdout).toContain("1/2 · npm run eval");
    // The sticky-comment marker is load-bearing — the GitHub Action's
    // in-place comment update keys off this exact string. If the eval
    // renderer ever drops or changes it, the action stops editing and
    // starts stacking new comments.
    expect(r.stdout).toContain("<!-- agent-eval:sticky-comment -->");
    expect(r.stdout).toContain("# Agent eval");
    // The composite / per-fixture table is the second load-bearing
    // artifact: the README's "Demo" prose calls it out by name.
    expect(r.stdout).toContain("composite");
    expect(r.stdout).toContain("| fixture | rec");
  });

  it("surface 2: trace:server --memory boots and /api/runs returns the seeded runs", () => {
    const r = runCapture();
    expect(r.stdout).toContain("2/2 · npm run trace:server");
    // The --memory boot seeds two synthetic runs with these exact
    // run_ids; if either disappears the empty-state UI ships and the
    // capture's last screen goes blank.
    expect(r.stdout).toContain('"run_id": "sample-finalized"');
    expect(r.stdout).toContain('"run_id": "sample-aborted"');
    // The response envelope shape (`runs`, `limit`, `offset`) is what
    // the React UI binds against; lock it here from the capture path
    // as belt-and-braces with whatever per-handler tests already exist.
    expect(r.stdout).toMatch(/"runs":\s*\[/);
    expect(r.stdout).toMatch(/"limit":\s*\d+/);
    expect(r.stdout).toMatch(/"offset":\s*\d+/);
  });

  it("script exists and the executable bit is set", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const mode = statSync(SCRIPT).mode;
    // owner-execute bit, the same predicate the sister Python smoke
    // tests use via os.access(..., os.X_OK).
    expect((mode & 0o100) !== 0).toBe(true);
  });
});
