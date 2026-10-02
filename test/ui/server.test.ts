import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { MemoryStore } from "../../src/trace/store.js";
import { createTraceServer } from "../../src/ui/server.js";

const PR: PlannerState["pr"] = { owner: "jt-mchorse", repo: "test", number: 9 };

function review(overrides: Partial<Review> = {}): Review {
  return {
    summary: "looks fine",
    findings: [],
    recommendation: "approve_with_comments",
    ...overrides,
  };
}

function sampleEvents(): TraceEvent[] {
  return [
    { ts: 1, kind: "run_started", pr: PR },
    {
      ts: 2,
      kind: "plan_emitted",
      plan: { goal: "ping", steps: [{ rationale: "warm", tool: "ping", input: { msg: "hi" } }] },
      version: 0,
    },
    {
      ts: 3,
      kind: "step_started",
      step: { rationale: "warm", tool: "ping", input: { msg: "hi" } },
      index: 0,
    },
    {
      ts: 4,
      kind: "observation",
      observation: {
        step: { rationale: "warm", tool: "ping", input: { msg: "hi" } },
        outcome: { kind: "ok", value: { pong: "hi" } },
        cost: { input_tokens: 12, output_tokens: 4, dollars: 0.0001 },
      },
    },
    { ts: 5, kind: "finalized", review: review() },
  ];
}

async function makeStaticDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "trace-ui-"));
  await writeFile(path.join(dir, "index.html"), "<!doctype html><h1>trace viewer test fixture</h1>", "utf8");
  await writeFile(path.join(dir, "app.js"), "console.log('test fixture app.js');", "utf8");
  return dir;
}

async function startServer(): Promise<{ url: string; server: Server; store: MemoryStore }> {
  const store = new MemoryStore();
  const staticDir = await makeStaticDir();
  const server = createTraceServer({ store, staticDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server.address() returned no port");
  return { url: `http://127.0.0.1:${addr.port}`, server, store };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("trace server", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    ctx = await startServer();
  });
  afterEach(async () => {
    await stop(ctx.server);
  });

  it("serves index.html at /", async () => {
    const r = await fetch(ctx.url + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const body = await r.text();
    expect(body).toContain("trace viewer test fixture");
  });

  it("serves /app.js with application/javascript content-type", async () => {
    const r = await fetch(ctx.url + "/app.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/javascript");
  });

  it("GET /api/runs returns an empty list when the store is empty", async () => {
    const r = await fetch(ctx.url + "/api/runs");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { runs: unknown[]; limit: number; offset: number };
    expect(body.runs).toEqual([]);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("GET /api/runs returns persisted run summaries with cost", async () => {
    await ctx.store.writeRun({
      run_id: "r-1",
      pr: PR,
      events: sampleEvents(),
      review: review(),
    });
    const r = await fetch(ctx.url + "/api/runs");
    const body = (await r.json()) as {
      runs: Array<{
        run_id: string;
        pr: typeof PR;
        total_cost: { dollars: number };
        recommendation: string;
      }>;
    };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.run_id).toBe("r-1");
    expect(body.runs[0]?.pr).toEqual(PR);
    expect(body.runs[0]?.total_cost.dollars).toBeCloseTo(0.0001, 6);
    expect(body.runs[0]?.recommendation).toBe("approve_with_comments");
  });

  it("GET /api/runs honors limit and offset", async () => {
    for (let i = 0; i < 5; i += 1) {
      await ctx.store.writeRun({
        run_id: `r-${i}`,
        pr: PR,
        events: [
          { ts: 1_700_000_000_000 + i * 1000, kind: "run_started", pr: PR },
          { ts: 1_700_000_000_001 + i * 1000, kind: "finalized", review: review() },
        ],
        review: review(),
      });
    }
    const r = await fetch(ctx.url + "/api/runs?limit=2&offset=1");
    const body = (await r.json()) as {
      runs: Array<{ run_id: string }>;
      limit: number;
      offset: number;
    };
    expect(body.runs.map((x) => x.run_id)).toEqual(["r-3", "r-2"]);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
  });

  it("GET /api/runs clamps an out-of-range window instead of 500ing", async () => {
    // `listRuns` now throws on a bad window (#117). The server must keep
    // clamping *before* it calls, so a hand-typed `?limit=-1&offset=-5` stays a
    // 200 with the defaults rather than surfacing the new RangeError as a 500.
    await ctx.store.writeRun({
      run_id: "clamp-1",
      pr: PR,
      events: sampleEvents(),
      review: review(),
    });
    for (const query of ["?limit=-1&offset=-5", "?limit=abc", "?limit=0", "?limit=1e9"]) {
      const r = await fetch(ctx.url + "/api/runs" + query);
      const body = (await r.json()) as { runs: Array<{ run_id: string }>; limit: number; offset: number };
      expect(r.status, query).toBe(200);
      expect(body.limit, query).toBeGreaterThanOrEqual(1);
      expect(body.offset, query).toBeGreaterThanOrEqual(0);
      expect(Number.isSafeInteger(body.limit), query).toBe(true);
    }
  });

  it("GET /api/runs/:id returns the full event log", async () => {
    await ctx.store.writeRun({
      run_id: "abc",
      pr: PR,
      events: sampleEvents(),
      review: review(),
    });
    const r = await fetch(ctx.url + "/api/runs/abc");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { run_id: string; events: Array<{ kind: string }> };
    expect(body.run_id).toBe("abc");
    expect(body.events).toHaveLength(5);
    expect(body.events[0]?.kind).toBe("run_started");
    expect(body.events.at(-1)?.kind).toBe("finalized");
  });

  it("GET /api/runs/:id 404s when the run is missing", async () => {
    const r = await fetch(ctx.url + "/api/runs/nope");
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 404 with JSON for unknown paths", async () => {
    const r = await fetch(ctx.url + "/banana");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
  });

  it.each(["%", "%ZZ", "%E0%A4%A", "abc%"])(
    "GET /api/runs/%s is the route's 404, not a 500 (#155)",
    async (segment) => {
      // A malformed escape threw URIError out of decodeURIComponent into the
      // catch-all: a 500 for a hand-typed URL, which #117's rule forbids.
      const r = await fetch(ctx.url + "/api/runs/" + segment);
      expect(r.status).toBe(404);
      const body = (await r.json()) as { error: string; run_id: string };
      expect(body.error).toMatch(/not found/i);
      expect(body.run_id).toBe(segment);
    },
  );

  it("a well-formed escape in /api/runs/:id still decodes (#155 control)", async () => {
    await ctx.store.writeRun({ run_id: "a/b", pr: PR, events: sampleEvents(), review: review() });
    const r = await fetch(ctx.url + "/api/runs/a%2Fb");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { run_id: string }).run_id).toBe("a/b");
  });

  it("an unparseable Host header does not reach new URL (#155)", async () => {
    const { request } = await import("node:http");
    const { port } = new URL(ctx.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: Number(port), path: "/api/runs", headers: { Host: "a b" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it.each([
    ["offset", "99999999999999999999", 10_000],
    ["offset", "9".repeat(400), 10_000],
    ["limit", "99999999999999999999", 500],
    ["limit", "9007199254740993", 500],
  ])("?%s=%s past MAX_SAFE_INTEGER clamps to the cap, not the default (#155)", async (name, raw, cap) => {
    await ctx.store.writeRun({ run_id: "far-1", pr: PR, events: sampleEvents(), review: review() });
    const r = await fetch(`${ctx.url}/api/runs?${name}=${raw}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { runs: unknown[]; limit: number; offset: number };
    expect(body[name as "limit" | "offset"]).toBe(cap);
    // A far page is an empty page, never the first one.
    if (name === "offset") expect(body.runs).toEqual([]);
  });

  it("a huge negative value still takes the default (#155 scope)", async () => {
    const r = await fetch(`${ctx.url}/api/runs?offset=-99999999999999999999&limit=-99999999999999999999`);
    const body = (await r.json()) as { limit: number; offset: number };
    expect([body.limit, body.offset]).toEqual([50, 0]);
  });

  it("clamps limit/offset out of band rather than failing the request", async () => {
    const r = await fetch(ctx.url + "/api/runs?limit=99999&offset=-5");
    const body = (await r.json()) as { limit: number; offset: number };
    expect(body.limit).toBeLessThanOrEqual(500);
    expect(body.offset).toBeGreaterThanOrEqual(0);
  });
});
