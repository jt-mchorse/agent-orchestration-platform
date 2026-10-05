/**
 * Under PORT=0 the trace-server logs the port it bound, not `:0` (#167).
 *
 * `src/io/env.ts` honours `PORT=0` ("let the OS pick a free port", #132), and
 * the startup line logged the requested port: `trace-server:
 * http://127.0.0.1:0/`, while the process listened elsewhere. The test runs
 * the real bin and follows the line it prints.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("trace-server banner under PORT=0 (#167)", () => {
  it("names a port that serves", async () => {
    const child = spawn("npx", ["tsx", path.join("src", "bin", "trace-server.ts"), "--memory"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: "0" },
      detached: true, // its own process group, so cleanup signals exactly it
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error(`no banner: ${buf}`)), 30_000);
        child.stdout.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = buf.match(/trace-server: (http:\/\/127\.0\.0\.1:\d+\/)/);
          if (m) {
            clearTimeout(timer);
            resolve(m[1] as string);
          }
        });
      });
      const url = new URL(line);
      expect(Number(url.port)).toBeGreaterThan(0);
      const res = await fetch(new URL("/api/runs", url));
      expect(res.status).toBe(200);
    } finally {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    }
  }, 60_000);
});
