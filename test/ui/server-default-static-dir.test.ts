import { readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../../src/trace/store.js";
import { createTraceServer, defaultStaticDir } from "../../src/ui/server.js";

/**
 * The default static dir is a filesystem path, not a URL pathname (#231).
 *
 * `createTraceServer` defaulted `staticDir` to
 * `path.dirname(new URL(import.meta.url).pathname)`, which is percent-encoded.
 * Measured on main from a checkout at `/tmp/aop sp/aop`: `/` and `/app.js`
 * answered 404, naming `/private/tmp/aop%20sp/aop/src/ui/index.html`.
 */
const SRC = path.resolve(__dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|js|mjs)$/.test(name) ? [full] : [];
  });
}

describe("trace server: default static dir (#231)", () => {
  let server: ReturnType<typeof createTraceServer> | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it.each([
    ["file:///tmp/aop%20sp/aop/src/ui/server.ts", "/tmp/aop sp/aop/src/ui"],
    ["file:///tmp/50%25/src/ui/server.ts", "/tmp/50%/src/ui"],
    ["file:///tmp/a%23b/src/ui/server.ts", "/tmp/a#b/src/ui"],
    ["file:///tmp/r%C3%A9sum%C3%A9/src/ui/server.ts", "/tmp/résumé/src/ui"],
    ["file:///tmp/plain/src/ui/server.ts", "/tmp/plain/src/ui"],
  ])("%s is the directory %s", (url, dir) => {
    expect(defaultStaticDir(url)).toBe(dir);
  });

  it("no source file takes the URL pathname of import.meta.url", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(10); // anti-vacuity: the walk found the tree
    // Code lines only: a comment may quote the old expression.
    const code = (f: string) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
    const offenders = files.filter((f) =>
      /new URL\(\s*import\.meta\.url\s*\)\.pathname/.test(code(f)),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("the default serves the shipped index.html and app.js", async () => {
    server = createTraceServer({ store: new MemoryStore() });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    for (const asset of ["/", "/app.js"]) {
      const res = await fetch(`http://127.0.0.1:${port}${asset}`);
      expect(res.status, asset).toBe(200);
    }
  });
});
