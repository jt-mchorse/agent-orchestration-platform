// A request path starting with `//` is a path, not a host (#159).
//
// #156 fixed the URL *base* so a bad Host header could not make `new URL`
// throw. The same constructor read a `//`-prefixed PATH as an authority:
// `//%` was a 500 from the catch-all and `//api/runs` silently routed as
// `/runs`. Raw sockets, because Node's http client normalises the path.
import { connect } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../../src/trace/store.js";
import { createTraceServer } from "../../src/ui/server.js";

let server: Server;
let port: number;

beforeEach(async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), "aop-ui-"));
  await writeFile(path.join(staticDir, "index.html"), "<html></html>");
  server = createTraceServer({ store: new MemoryStore(), staticDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function raw(target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (c) => (data += c.toString("utf8")));
    sock.on("end", () => {
      const status = Number(data.split(" ")[1]);
      resolve({ status, body: data.slice(data.indexOf("\r\n\r\n") + 4) });
    });
    sock.on("error", reject);
  });
}

describe("trace server: a // path is a path (#159)", () => {
  it.each(["//%", "//a:b/x", "//["])("%s is not a 500", async (target) => {
    const r = await raw(target);
    expect(r.status).not.toBe(500);
    expect(r.status).toBe(404);
  });

  it("//api/runs is a 404 naming the path it was given, not routed as /runs", async () => {
    const r = await raw("//api/runs");
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).path).toBe("//api/runs");
  });

  it("an absolute-form target with a bad host is a 400, not a 500", async () => {
    const r = await raw("http://[/api/runs");
    expect(r.status).toBe(400);
  });

  it("/api/runs and its query string are unchanged (control)", async () => {
    const r = await raw("/api/runs?limit=5&offset=0");
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { limit: number; offset: number };
    expect([body.limit, body.offset]).toEqual([5, 0]);
  });

  it("an absolute-form target to a real route still works (control)", async () => {
    const r = await raw(`http://127.0.0.1:${port}/api/runs`);
    expect(r.status).toBe(200);
  });
});
