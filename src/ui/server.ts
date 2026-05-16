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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TraceStore } from "../trace/store.js";

export interface TraceServerOptions {
  store: TraceStore;
  /** Override for tests — defaults to the sibling `index.html` / `app.js`. */
  staticDir?: string;
}

export function createTraceServer(opts: TraceServerOptions): Server {
  const staticDir = opts.staticDir ?? path.dirname(new URL(import.meta.url).pathname);

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

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await sendStatic(res, path.join(staticDir, "index.html"), "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    await sendStatic(res, path.join(staticDir, "app.js"), "application/javascript; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/runs") {
    const limit = clampNumber(url.searchParams.get("limit"), 50, 1, 500);
    const offset = clampNumber(url.searchParams.get("offset"), 0, 0, 10_000);
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

async function sendStatic(res: ServerResponse, file: string, contentType: string): Promise<void> {
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

function clampNumber(raw: string | null, fallback: number, lo: number, hi: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
