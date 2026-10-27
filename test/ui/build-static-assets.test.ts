/**
 * The build ships the trace viewer's static files beside the built server (#269).
 *
 * `npm run build` was `tsc -p tsconfig.json`, and `tsc` emits only what it
 * compiles: `dist/src/ui/` held `server.{js,d.ts,js.map}` and nothing else.
 * Measured on main 6a13c88: `PORT=0 node dist/src/bin/trace-server.js --memory`
 * answered 404 for `/` and `/app.js` (naming `dist/src/ui/index.html`) and 200
 * for `/api/runs`. #231 fixed the same 404 for a URL-encoded checkout path; this
 * is the built tree, where the default dir is right and the files are absent.
 *
 * The arms run the `build` script's own steps into a scratch outDir inside the
 * checkout (so the built bin resolves `node_modules` the way `dist/` does),
 * then start the BUILT bin and fetch the UI.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultStaticDir } from "../../src/ui/server.js";
import { buildInto, buildScript, REPO_ROOT } from "../helpers/build-into.js";

const SRC = path.join(REPO_ROOT, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe("build: static assets reach dist (#269)", () => {
  let outDir: string;

  beforeAll(() => {
    // Run the steps of the `build` script itself, redirected to a scratch
    // outDir (`.tmp-*/` is gitignored), so this follows whatever `build` does.
    outDir = mkdtempSync(path.join(REPO_ROOT, ".tmp-build-"));
    buildInto(outDir);
  }, 120_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("the build script runs the copy step after tsc", () => {
    expect(buildScript()).toBe("tsc -p tsconfig.json && node scripts/copy-static-assets.mjs");
  });

  it("the built server's default static dir holds index.html and app.js", () => {
    const serverJs = path.join(outDir, "src", "ui", "server.js");
    const dir = defaultStaticDir(pathToFileURL(serverJs).href);
    expect(dir).toBe(path.dirname(serverJs));
    for (const name of ["index.html", "app.js"]) {
      expect(readFileSync(path.join(dir, name), "utf8")).toBe(
        readFileSync(path.join(SRC, "ui", name), "utf8"),
      );
    }
  });

  it("every non-TypeScript file under src/ is copied byte-for-byte", () => {
    const assets = files(SRC).filter((f) => !f.endsWith(".ts"));
    expect(assets.length).toBeGreaterThanOrEqual(2); // anti-vacuity: index.html + app.js
    for (const f of assets) {
      const copied = path.join(outDir, "src", path.relative(SRC, f));
      expect(readFileSync(copied)).toEqual(readFileSync(f));
    }
  });

  it("the built trace server serves /, /app.js and /api/runs", async () => {
    const child = spawn(
      process.execPath,
      [path.join(outDir, "src", "bin", "trace-server.js"), "--memory"],
      { cwd: REPO_ROOT, env: { ...process.env, PORT: "0" } },
    );
    try {
      const base = await new Promise<string>((resolve, reject) => {
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
      const statuses: Record<string, number> = {};
      for (const p of ["/", "/app.js", "/api/runs"]) {
        statuses[p] = (await fetch(new URL(p, base))).status;
      }
      expect(statuses).toEqual({ "/": 200, "/app.js": 200, "/api/runs": 200 });
    } finally {
      child.kill("SIGTERM");
    }
  }, 60_000);
});
