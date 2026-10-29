import { readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/trace/store.js";
import { createTraceServer } from "../../src/ui/server.js";

/**
 * The trace viewer shows the API's error body, not just the status (#289).
 *
 * Both screens' fetch chains rejected a non-OK response with
 * `new Error("HTTP " + r.status)` and never read the body. #153 made the server
 * name the cause (`{"error": "connect ECONNREFUSED 127.0.0.1:1"}` on a fresh
 * clone with no database), and the page still read "Failed to load runs:
 * HTTP 500".
 *
 * `app.js` imports React from a CDN and renders at import time, so as in the
 * other UI tests it is not imported. Each screen's `.then((r) => ...)` response
 * handler is lifted from the shipped source verbatim, with whatever helpers it
 * calls, and run against real `Response`s from `createTraceServer`.
 */
const APP_JS = readFileSync(path.resolve(__dirname, "../../src/ui/app.js"), "utf8");

function functionBody(name: string): string {
  const m = APP_JS.match(new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"));
  if (!m) throw new Error(`${name} not found in src/ui/app.js`);
  return m[0];
}

/** Every top-level `async function` in app.js, which a handler may call. */
function asyncHelpers(): string {
  return [...APP_JS.matchAll(/^async function \w+\([^)]*\) \{\n[\s\S]*?\n\}\n/gm)]
    .map((m) => m[0])
    .join("\n");
}

type Handler = (r: Response) => Promise<unknown>;

/** The response handler of the `fetch(...)` chain inside *screen*. */
function responseHandler(screen: string): Handler {
  const body = functionBody(screen);
  const arg = body.match(/fetch\([^\n]*\)\n\s*\.then\(([\s\S]*?)\)\n\s*\.then\(/)?.[1];
  if (!arg) throw new Error(`${screen}: fetch(...).then(handler) not found`);
  // An array literal, so a trailing comma after a multi-line handler parses.
  return new Function(`${asyncHelpers()}\nreturn [${arg}][0];`)() as Handler;
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the handler to reject");
}

function refusedLikePg(): AggregateError {
  const v6 = Object.assign(new Error("connect ECONNREFUSED ::1:5432"), { code: "ECONNREFUSED" });
  const v4 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
    code: "ECONNREFUSED",
  });
  return Object.assign(new AggregateError([v6, v4], ""), { code: "ECONNREFUSED" });
}

let server: Server;
let base: string;
let port: number;
const deadDb = { value: false };

beforeAll(async () => {
  const store = new MemoryStore();
  const { listRuns, getRun } = store;
  store.listRuns = async (q) => {
    if (deadDb.value) throw refusedLikePg();
    return listRuns.call(store, q);
  };
  store.getRun = async (id) => {
    if (deadDb.value) throw refusedLikePg();
    return getRun.call(store, id);
  };
  server = createTraceServer({ store, staticDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function deadDbResponse(p: string): Promise<Response> {
  deadDb.value = true;
  try {
    return await fetch(base + p);
  } finally {
    deadDb.value = false;
  }
}

/**
 * The server's 400 for a request target that is not a URL. `fetch` cannot send
 * one, so it goes over a raw socket and the reply is rebuilt as a `Response`.
 */
async function badTargetResponse(): Promise<Response> {
  const raw = await new Promise<string>((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => (buf += d));
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
    sock.write("GET http://a%zz/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  });
  const status = Number(raw.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
  const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const SCREENS = ["RunList", "RunDetail"] as const;

describe("trace viewer app.js: a non-OK response names the server's error (#289)", () => {
  it.each(SCREENS)("%s: the 500 for a refused database names the connection", async (screen) => {
    const r = await deadDbResponse(screen === "RunList" ? "/api/runs?limit=50" : "/api/runs/x");
    expect(r.status).toBe(500);
    expect(await rejection(responseHandler(screen)(r))).toBe(
      "HTTP 500: connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  it("RunDetail: the 404 for a missing run says so", async () => {
    const r = await fetch(base + "/api/runs/missing");
    expect(r.status).toBe(404);
    expect(await rejection(responseHandler("RunDetail")(r))).toBe("HTTP 404: run not found");
  });

  it.each(SCREENS)("%s: the 400 carries its detail", async (screen) => {
    const r = await badTargetResponse();
    expect(r.status).toBe(400);
    expect(await rejection(responseHandler(screen)(r))).toBe(
      "HTTP 400: bad request: request target is not a valid URL",
    );
  });

  it.each(SCREENS)("%s: a body that is not JSON keeps the bare status", async (screen) => {
    const handler = responseHandler(screen);
    const html = new Response("<html><body>Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    expect(await rejection(handler(html))).toBe("HTTP 502");
    expect(await rejection(handler(new Response("", { status: 503 })))).toBe("HTTP 503");
  });

  it.each(SCREENS)("%s: JSON with no string `error` keeps the bare status", async (screen) => {
    const handler = responseHandler(screen);
    for (const body of ["null", "[]", '{"error": 5}', '{"error": ""}', '{"detail": "only"}']) {
      expect(await rejection(handler(new Response(body, { status: 500 }))), body).toBe("HTTP 500");
    }
  });

  it.each(SCREENS)("%s: an OK response still resolves to its body (control)", async (screen) => {
    const r = await fetch(base + (screen === "RunList" ? "/api/runs?limit=50" : "/api/runs"));
    expect(r.ok).toBe(true);
    expect(await responseHandler(screen)(r)).toMatchObject({ runs: [] });
  });

  it.each(SCREENS)("%s: markup in the body stays text in the message", async (screen) => {
    const markup = '<img src=x onerror="alert(1)">';
    const r = new Response(JSON.stringify({ error: markup }), { status: 500 });
    expect(await rejection(responseHandler(screen)(r))).toBe("HTTP 500: " + markup);
  });
});

describe("trace viewer app.js: the error message is rendered as text (#289)", () => {
  it.each([
    ["RunList", "Failed to load runs: "],
    ["RunDetail", "Failed to load run: "],
  ])("%s interpolates `err` as a text child", (screen, label) => {
    const body = functionBody(screen);
    expect(body).toContain(`if (err) return html\`<div class="empty">${label}\${err}</div>\`;`);
  });

  it("app.js never sets raw HTML", () => {
    expect(APP_JS).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/);
  });
});
