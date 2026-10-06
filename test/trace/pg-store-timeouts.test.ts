/**
 * A database that accepts and never answers fails within a bound (#175).
 *
 * `PgStore` built its pool with only a connection string, and `pg` waits
 * forever for a connection and for a query: a host that accepted TCP and never
 * spoke Postgres hung every trace-server request (`curl --max-time 20` got
 * nothing). These arms use the real `pg` pool against a loopback listener that
 * accepts and stays silent -- no database needed.
 */
import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { PgStore } from "../../src/trace/pg-store.js";

const sockets: net.Socket[] = [];
let listener: net.Server | undefined;

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await new Promise<void>((done) => (listener ? listener.close(() => done()) : done()));
  listener = undefined;
});

async function silentDatabase(): Promise<string> {
  listener = net.createServer((s) => sockets.push(s));
  await new Promise<void>((done) => listener!.listen(0, "127.0.0.1", () => done()));
  return `postgresql://u:p@127.0.0.1:${(listener!.address() as AddressInfo).port}/x`;
}

describe("PgStore against a database that never answers (#175)", () => {
  it("listRuns rejects within the connection timeout instead of hanging", async () => {
    const store = new PgStore({ connectionString: await silentDatabase(), connectionTimeoutMs: 300 });
    const started = Date.now();
    try {
      await expect(store.listRuns({ limit: 1 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await store.close().catch(() => {});
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a timeout of %s at construction", (bad) => {
    expect(() => new PgStore({ connectionTimeoutMs: bad })).toThrow(RangeError);
    expect(() => new PgStore({ queryTimeoutMs: bad })).toThrow(RangeError);
  });
});
