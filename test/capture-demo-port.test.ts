/**
 * The capture curls the server it started, or fails (#169).
 *
 * `scripts/capture_demo.sh` used to wait only for *something* to accept on
 * the trace port. When another process already held it, the spawned
 * MemoryStore server died of EADDRINUSE into /dev/null, the poll succeeded
 * against the other process, and the demo recorded that process's runs
 * under a "wired end-to-end on hermetic fixtures" banner -- exit 0. The script
 * now waits for its own server's listen line and curls the port that names.
 *
 * The child is spawned asynchronously: the port-holder below is an HTTP
 * server in this process, and `spawnSync` would block the event loop it
 * needs to answer, which is the case the unfixed script curls.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "capture_demo.sh");

function runCapture(port: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, CAPTURE_PACE_SECONDS: "0", CAPTURE_TRACE_PORT: port },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));
}

describe("scripts/capture_demo.sh trace port (#169)", () => {
  it("fails, naming the port, when another process already holds it -- and shows none of its data", async () => {
    const foreign = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"runs":[{"run_id":"FOREIGN-RUN"}],"limit":50,"offset":0}');
    });
    const port = await listen(foreign);
    try {
      const r = await runCapture(String(port));
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).not.toContain("FOREIGN-RUN");
      expect(r.stdout).not.toContain("wired end-to-end on hermetic fixtures");
      expect(r.stderr).toContain(`did not start on port ${port}`);
      expect(r.stderr).toContain("EADDRINUSE");
    } finally {
      await new Promise((done) => foreign.close(done));
    }
  }, 70_000);

  it("CAPTURE_TRACE_PORT=0 boots on a free port and returns the two seeded runs", async () => {
    const r = await runCapture("0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('"run_id": "sample-finalized"');
    expect(r.stdout).toContain('"run_id": "sample-aborted"');
    const hint = r.stdout.match(/open http:\/\/127\.0\.0\.1:(\d+)\//);
    expect(hint).not.toBeNull();
    expect(Number(hint![1])).toBeGreaterThan(0);
  }, 70_000);
});
