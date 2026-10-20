/**
 * An error on an idle pooled client must not kill the process (#242).
 *
 * `pg` emits such an error (a Postgres restart, failover or
 * `pg_terminate_backend` while the client sat unused) on the pool, and an
 * `'error'` event with no listener throws: the trace server exited 1 instead of
 * failing one request. Emitting on the pool `PgStore` built reproduces that
 * throw without a database; `pg-store.test.ts` carries the live
 * `pg_terminate_backend` arm.
 */
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PgStore } from "../../src/trace/pg-store.js";

type Emitter = { emit(event: string, ...args: unknown[]): boolean; listenerCount(event: string): number };

async function poolOf(store: PgStore): Promise<Emitter> {
  // Built lazily and never connected here: `pg` opens no socket until a query.
  return (store as unknown as { getPool(): Promise<Emitter> }).getPool();
}

function idleClientError(): Error {
  return Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PgStore pool 'error' on an idle client (#242)", () => {
  it("does not throw when the pool it built emits 'error'", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new PgStore({ connectionString: "postgresql://u:p@127.0.0.1:1/x" });
    try {
      const pool = await poolOf(store);
      expect(() => pool.emit("error", idleClientError())).not.toThrow();
      // Logged, not swallowed silently.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("terminating connection due to administrator command");
    } finally {
      await store.close();
    }
  });

  it("control: an unlistened 'error' on a bare pg Pool throws (the crash mechanism)", async () => {
    const { Pool } = (await import("pg" as unknown as string)) as {
      Pool: new (cfg: { connectionString: string }) => Emitter & { end(): Promise<void> };
    };
    const pool = new Pool({ connectionString: "postgresql://u:p@127.0.0.1:1/x" });
    try {
      expect(() => pool.emit("error", idleClientError())).toThrow(/administrator command/);
    } finally {
      await pool.end();
    }
  });

  it("control: an injected pool is left to its caller (no listener added)", async () => {
    const injected = Object.assign(new EventEmitter(), {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    });
    const store = new PgStore({ pool: injected });
    await store.listRuns({ limit: 1 });
    expect(injected.listenerCount("error")).toBe(0);
  });
});
