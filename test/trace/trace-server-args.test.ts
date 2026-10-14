/**
 * The trace-server refuses an argument it does not know, before it binds (#217).
 *
 * It read its one flag with `process.argv.includes("--memory")`, so a typo'd
 * `--memroy` silently started the Postgres-backed server (on a fresh clone,
 * every API call a 500 naming the refused connection) and `--help` held a
 * port until killed. `validate` (#188) and `eval` (#161) already refused both.
 *
 * Each refusal test asserts the process EXITS on its own; a server that bound
 * a port never would, so the timeout path kills it and reports the banner.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BANNER = /trace-server: http:\/\/127\.0\.0\.1:(\d+)\//;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  exitedOnItsOwn: boolean;
}

function runServer(args: string[], waitMs = 20_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", path.join("src", "bin", "trace-server.ts"), ...args], {
      cwd: REPO_ROOT,
      // An unreachable database, so a server that wrongly starts on PgStore
      // cannot be mistaken for a working one.
      env: { ...process.env, PORT: "0", DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
      detached: true, // its own process group, so cleanup signals exactly it
    });
    let stdout = "";
    let stderr = "";
    let exitedOnItsOwn = true;
    const kill = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      exitedOnItsOwn = false;
      kill();
    }, waitMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      // A bound server never exits on its own; stop waiting once it says so.
      if (BANNER.test(stdout)) {
        clearTimeout(timer);
        exitedOnItsOwn = false;
        kill();
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, exitedOnItsOwn });
    });
    child.on("error", reject);
  });
}

const T = 60_000;

describe("trace-server argument handling (#217)", () => {
  it(
    "baseline: --memory still binds and serves the seeded store",
    async () => {
      const r = await runServer(["--memory"]);
      expect(r.stdout).toContain("started with MemoryStore");
      expect(r.stdout).toMatch(BANNER);
      expect(r.exitedOnItsOwn).toBe(false);
    },
    T,
  );

  it.each([{ args: ["--memroy"] }, { args: ["memory"] }, { args: ["--memory", "--port=9000"] }])(
    "$args exits 2 naming the argument, without building a store or binding",
    async ({ args }) => {
      const r = await runServer(args);
      expect(r.exitedOnItsOwn).toBe(true);
      expect(r.code).toBe(2);
      const bad = args[args.length - 1] as string;
      expect(r.stderr).toContain(`unknown argument: ${bad}`);
      expect(r.stderr).toContain("usage: trace-server");
      expect(r.stdout).not.toContain("started with");
      expect(r.stdout).not.toMatch(BANNER);
    },
    T,
  );

  it.each([["--help"], ["-h"]])(
    "%s prints the usage and exits 0 without binding",
    async (flag) => {
      const r = await runServer([flag]);
      expect(r.exitedOnItsOwn).toBe(true);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("usage: trace-server [--memory]");
      expect(r.stdout).not.toContain("started with");
      expect(r.stdout).not.toMatch(BANNER);
    },
    T,
  );
});
