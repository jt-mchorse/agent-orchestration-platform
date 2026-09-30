/**
 * The trace server's 500 body is never empty (#153).
 *
 * A fresh clone's `npm run trace:server` (PgStore, no database) answered
 * `GET /api/runs` with `{"error": ""}`: pg's refused connection is an
 * `AggregateError` whose own message is empty.
 */
import { describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { MemoryStore } from "../../src/trace/store.js";
import { createTraceServer, describeError } from "../../src/ui/server.js";

function refusedLikePg(): AggregateError {
  const v6 = Object.assign(new Error("connect ECONNREFUSED ::1:5432"), { code: "ECONNREFUSED" });
  const v4 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  return Object.assign(new AggregateError([v6, v4], ""), { code: "ECONNREFUSED" });
}

describe("describeError (#153)", () => {
  it("names the refused connection an AggregateError hides", () => {
    expect(describeError(refusedLikePg())).toBe(
      "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    );
  });
  it("keeps an ordinary message", () => {
    expect(describeError(new Error("run not found"))).toBe("run not found");
  });
  it("falls back to code, then name, then a fixed string", () => {
    expect(describeError(Object.assign(new Error(""), { code: "EPIPE" }))).toBe("EPIPE");
    expect(describeError(new TypeError(""))).toBe("TypeError");
    expect(describeError({})).toBe("internal error");
  });
});

describe("the 500 path through createTraceServer (#153)", () => {
  it("answers with the cause, not an empty string", async () => {
    const store = new MemoryStore();
    store.listRuns = async () => {
      throw refusedLikePg();
    };
    const server: Server = createTraceServer({ store, staticDir: "/nonexistent" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const r = await fetch(`http://127.0.0.1:${port}/api/runs`);
      expect(r.status).toBe(500);
      const body = (await r.json()) as { error: string };
      expect(body.error).toContain("ECONNREFUSED 127.0.0.1:5432");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
