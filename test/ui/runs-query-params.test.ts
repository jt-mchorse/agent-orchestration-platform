/**
 * `/api/runs` must resolve its window *consistently* (#126).
 *
 * The lenient posture is deliberate and predates this: `listRuns` throws on a
 * bad window (#117), so the server resolves `limit`/`offset` before calling it
 * and a hand-typed query stays a 200 rather than surfacing a `RangeError` as a
 * 500. `test/ui/server.test.ts`'s clamping test states that intent as "stays a
 * 200 **with the defaults**".
 *
 * `clampNumber` was not consistently lenient. It fell back for some malformed
 * values and clamped others to `lo`, and it could not tell an absent parameter
 * from a present-but-empty one. Measured on `limit` (fallback 50, lo 1, hi 500):
 *
 *     ?limit=          ->   1     present-but-empty, NOT the fallback
 *     ?limit=%20       ->   1     same road
 *     ?limit=abc       ->  50     the fallback
 *     ?limit=-5        ->   1     clamped to `lo`, not the fallback
 *     ?limit=0         ->   1     clamped to `lo`, not the fallback
 *     ?limit=0x10      ->  16     `Number("0x10")` is 16
 *     ?limit=1_000     ->  50     `Number("1_000")` is NaN
 *     ?limit=25.9      ->  25     silently truncated
 *
 * `?limit=` returning ONE run rather than fifty is the sharp one: the guard
 * tested `raw === null`, which is *absent*, while a present-but-empty value is
 * `""` and `Number("") === 0`, which the clamp then lifted to `lo`. That is the
 * distinction #124 settled at the env seam, asked for the first time here.
 *
 * Whether a malformed parameter should instead be a 400 reverses the #117
 * posture and is filed as a decision-revisit rather than settled here.
 *
 * Driven through the real HTTP handler, not a copy of the helper — the helper is
 * private and the contract under test is the endpoint's.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../../src/trace/store.js";
import { createTraceServer } from "../../src/ui/server.js";

async function makeStaticDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "trace-ui-params-"));
  await writeFile(path.join(dir, "index.html"), "<!doctype html>", "utf8");
  await writeFile(path.join(dir, "app.js"), "", "utf8");
  return dir;
}

async function startServer(): Promise<{ url: string; server: Server }> {
  const store = new MemoryStore();
  const staticDir = await makeStaticDir();
  const server = createTraceServer({ store, staticDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("server.address() returned no port");
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_OFFSET = 10_000;

describe("/api/runs query parameters", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    ctx = await startServer();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  });

  async function get(
    query: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await fetch(ctx.url + "/api/runs" + query);
    return {
      status: r.status,
      body: (await r.json()) as Record<string, unknown>,
    };
  }

  // Every shape that must resolve to the DEFAULT limit of 50. The first three
  // are the present-but-empty class; the rest are malformed values that used to
  // split between "fall back" and "clamp to lo".
  const USES_DEFAULT: ReadonlyArray<readonly [string, string]> = [
    ["absent", ""],
    ["present but empty", "?limit="],
    ["whitespace only (space)", "?limit=%20"],
    ["whitespace only (tab)", "?limit=%09"],
    ["non-numeric", "?limit=abc"],
    ["negative", "?limit=-5"],
    ["zero, below lo=1", "?limit=0"],
    ["fractional", "?limit=25.9"],
    ["hex", "?limit=0x10"],
    ["numeric separator", "?limit=1_000"],
    ["exponent", "?limit=1e2"],
    ["overflowing", "?limit=1e400"],
    ["the string 'null'", "?limit=null"],
  ];

  it.each(USES_DEFAULT)(
    "%s -> the default limit of 50",
    async (_label, query) => {
      const { status, body } = await get(query);
      expect(status).toBe(200);
      expect(body.limit).toBe(DEFAULT_LIMIT);
    },
  );

  it("an explicit valid window is honoured (control)", async () => {
    // Without this, a change that made every request use the default would pass
    // every case above.
    const { status, body } = await get("?limit=7&offset=3");
    expect(status).toBe(200);
    expect(body.limit).toBe(7);
    expect(body.offset).toBe(3);
  });

  it("the shipped UI's own request still works (control)", async () => {
    // `src/ui/app.js` hardcodes this exact query; it is the one request the
    // application actually makes.
    const { status, body } = await get("?limit=50");
    expect(status).toBe(200);
    expect(body.limit).toBe(DEFAULT_LIMIT);
  });

  it("present-but-empty is now indistinguishable from absent", async () => {
    // The defect, stated as the property. Before: absent -> 50, `?limit=` -> 1.
    const absent = await get("");
    const empty = await get("?limit=");
    expect(empty.body.limit).toBe(absent.body.limit);
    expect(empty.body.offset).toBe(absent.body.offset);
  });

  it("hex and numeric-separator spellings now agree with each other", async () => {
    // They used to disagree: `Number("0x10")` is 16 and `Number("1_000")` is NaN,
    // so one silently became a limit of 16 and the other silently became 50.
    const hex = await get("?limit=0x10");
    const sep = await get("?limit=1_000");
    expect(hex.body.limit).toBe(sep.body.limit);
    expect(hex.body.limit).toBe(DEFAULT_LIMIT);
  });

  it("above the server maximum is still clamped, not defaulted", async () => {
    // The upper bound protects the server from an expensive query rather than
    // stating what a caller may ask for, so "as many as you'll give me" is
    // answered with the maximum — not with the default, which would be *fewer*
    // rows than the caller asked for and fewer than the server would serve.
    const { status, body } = await get("?limit=99999");
    expect(status).toBe(200);
    expect(body.limit).toBe(MAX_LIMIT);
  });

  it("an offset above its maximum is clamped the same way", async () => {
    const { status, body } = await get("?offset=999999");
    expect(status).toBe(200);
    expect(body.offset).toBe(MAX_OFFSET);
  });

  it("a leading/trailing-space integer is accepted, not defaulted", async () => {
    // Trimming happens before parsing, which is what makes the empty and
    // whitespace-only cases take the same road as absent.
    const { status, body } = await get("?limit=%2012%20");
    expect(status).toBe(200);
    expect(body.limit).toBe(12);
  });

  it("offset follows the same rule as limit", async () => {
    // `offset`'s bug was invisible because its `lo` and its fallback are both 0,
    // so clamping and defaulting produced the same number. It shares the helper,
    // so it shares the fix; asserted rather than assumed.
    for (const query of [
      "?offset=",
      "?offset=%20",
      "?offset=abc",
      "?offset=-1",
      "?offset=1_0",
    ]) {
      const { status, body } = await get(query);
      expect(status, query).toBe(200);
      expect(body.offset, query).toBe(0);
    }
    const valid = await get("?offset=4");
    expect(valid.body.offset).toBe(4);
  });

  it("the response always echoes the effective window back", async () => {
    // What keeps the remaining clamp from being silent: a caller who asked for
    // 99999 can see they were served 500.
    for (const query of ["", "?limit=", "?limit=99999", "?limit=7"]) {
      const { body } = await get(query);
      expect(typeof body.limit, query).toBe("number");
      expect(typeof body.offset, query).toBe("number");
    }
  });
});
