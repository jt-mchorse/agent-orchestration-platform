/**
 * Trace viewer HTTP server (#6).
 *
 * Stdlib-only on the server side: `http.createServer` plus a small route
 * dispatch. Same reasoning as rag-production-kit's D-011 — avoid pulling
 * Express/Fastify into the dep graph for a debug/telemetry surface that
 * has four endpoints. Cross-origin and auth are explicitly NOT covered;
 * this is a local viewer.
 *
 * Endpoints:
 *   GET /                      → index.html
 *   GET /app.js                → app.js (the React-via-ESM-CDN entrypoint)
 *   GET /api/runs              → list run summaries (paginated)
 *   GET /api/runs/:run_id      → one run's full event log
 *
 * The store is injected at construction so tests can pass `MemoryStore`
 * and integration paths can pass `PgStore`. There's no "default" store —
 * the caller decides.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TraceStore } from "../trace/store.js";

export interface TraceServerOptions {
  store: TraceStore;
  /** Override for tests — defaults to the sibling `index.html` / `app.js`. */
  staticDir?: string;
}

export function createTraceServer(opts: TraceServerOptions): Server {
  const staticDir =
    opts.staticDir ?? path.dirname(new URL(import.meta.url).pathname);

  return createServer(async (req, res) => {
    try {
      await dispatch(req, res, opts.store, staticDir);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  store: TraceStore,
  staticDir: string,
): Promise<void> {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  // Strip query string for routing; we don't have any query params yet
  // beyond `?limit=&offset=` which we parse manually.
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  ) {
    await sendStatic(
      res,
      path.join(staticDir, "index.html"),
      "text/html; charset=utf-8",
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    await sendStatic(
      res,
      path.join(staticDir, "app.js"),
      "application/javascript; charset=utf-8",
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/runs") {
    const limit = resolveIntParam(url.searchParams.get("limit"), 50, 1, 500);
    const offset = resolveIntParam(
      url.searchParams.get("offset"),
      0,
      0,
      10_000,
    );
    const runs = await store.listRuns({ limit, offset });
    sendJson(res, 200, { runs, limit, offset });
    return;
  }
  const detailMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const runId = decodeURIComponent(detailMatch[1] as string);
    const detail = await store.getRun(runId);
    if (!detail) {
      sendJson(res, 404, { error: "run not found", run_id: runId });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }
  sendJson(res, 404, { error: "not found", path: url.pathname });
}

async function sendStatic(
  res: ServerResponse,
  file: string,
  contentType: string,
): Promise<void> {
  try {
    const body = await fs.readFile(file);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(body.byteLength));
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "static asset not found", file });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

const DECIMAL_INTEGER = /^[+-]?\d+$/;

/**
 * Resolve a non-negative integer query parameter, leniently (#126).
 *
 * The lenient posture is deliberate and predates this function: `listRuns`
 * throws on a bad window (#117), so `/api/runs` resolves the window *before*
 * calling it, and a hand-typed query stays a 200 rather than surfacing a
 * `RangeError` as a 500. That is unchanged here. What changed is that the old
 * `clampNumber` was not consistently lenient — it fell back for some malformed
 * values and clamped others to `lo`, and could not tell an absent parameter
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
 * `?limit=` returning ONE run rather than fifty is the sharp one. The guard
 * tested `raw === null`, which is *absent*; a present-but-empty value is `""`,
 * and `Number("") === 0`, which the clamp then lifted to `lo`. That is the
 * distinction #124 settled at the env seam — "`??` fires on `null`/`undefined`
 * only, so an empty variable is passed through verbatim" — asked for the first
 * time here, at the query-parameter seam, which #124's audit of "four
 * env-reading sites" did not cover.
 *
 * `0x10` -> 16 while `1_000` -> 50 is the second: two non-decimal spellings,
 * opposite verdicts, neither intended. Both come from inheriting `Number()`'s
 * domain instead of stating one.
 *
 * The rule now, applied uniformly:
 *
 * - absent, empty, or whitespace-only        -> the default
 * - not a decimal integer, or below `lo`     -> the default
 * - above `hi`                               -> `hi`
 *
 * "Below `lo` yields the default" is what `test/ui/server.test.ts`'s clamping
 * test already says in prose — "stays a 200 **with the defaults**" — and what
 * the code did not do: `?limit=-1` returned 1, not 50. Above `hi` still clamps,
 * because that bound protects the server from an expensive query rather than
 * stating what a caller may ask for. Both outcomes are echoed back in the
 * response body, so neither is silent.
 *
 * Whether a malformed parameter should instead be a **400** is a real question
 * and a reversal of the #117 posture, so it is filed for a deliberate decision
 * rather than settled here.
 */
function resolveIntParam(
  raw: string | null,
  fallback: number,
  lo: number,
  hi: number,
): number {
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  if (!DECIMAL_INTEGER.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return fallback;
  if (n < lo) return fallback;
  return Math.min(hi, n);
}
