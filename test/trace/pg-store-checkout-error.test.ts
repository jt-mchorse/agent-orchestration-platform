/**
 * An error on a CHECKED-OUT client must not kill the process (#248).
 *
 * pg-pool removes its idle `'error'` listener while a client is checked out,
 * so a Postgres restart, failover or `pg_terminate_backend` in the middle of
 * `getRun`'s or `writeRun`'s transaction emitted `'error'` on a client with no
 * listener, and the throw killed the trace server. #242's pool listener covers
 * idle clients only. The fake client below fails the way pg's
 * `Client._handleErrorEvent` does: it rejects the in-flight query, then emits
 * `'error'` on itself. `pg-store.test.ts` carries the live
 * `pg_terminate_backend` arm.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../../src/agent/trace.js";
import type { PlannerState, Review } from "../../src/agent/types.js";
import { PgStore } from "../../src/trace/pg-store.js";

const PR: PlannerState["pr"] = { owner: "jt-mchorse", repo: "t", number: 1 };
const REVIEW: Review = { summary: "s", findings: [], recommendation: "approve" };
const EVENTS: TraceEvent[] = [{ ts: 1_700_000_000_000, kind: "run_started", pr: PR }];

function terminated(): Error {
  return Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
}

class FakeClient extends EventEmitter {
  releasedWith: Array<Error | undefined> = [];
  private pending: ((err: Error) => void) | null = null;

  constructor(private readonly hangOn: RegExp | null) {
    super();
  }

  async query(sql: string): Promise<{ rows: unknown[] }> {
    if (this.hangOn && this.hangOn.test(sql)) {
      return new Promise((_resolve, reject) => {
        this.pending = reject;
      });
    }
    return { rows: [] };
  }

  get waiting(): boolean {
    return this.pending !== null;
  }

  /** What pg does when the backend goes away mid-query. Throws if nobody listens. */
  dropConnection(err: Error): void {
    this.pending?.(err);
    this.pending = null;
    this.emit("error", err);
  }

  release(err?: Error): void {
    this.releasedWith.push(err);
  }
}

/** Hands out `first`, then healthy clients. */
function poolOf(first: FakeClient) {
  const handedOut: FakeClient[] = [];
  return {
    handedOut,
    pool: {
      async query(): Promise<{ rows: unknown[] }> {
        return { rows: [] };
      },
      async connect(): Promise<FakeClient> {
        const c = handedOut.length === 0 ? first : new FakeClient(null);
        handedOut.push(c);
        return c;
      },
      async end(): Promise<void> {},
    },
  };
}

async function untilWaiting(client: FakeClient): Promise<void> {
  for (let i = 0; i < 100 && !client.waiting; i += 1) await new Promise((r) => setTimeout(r, 1));
  expect(client.waiting).toBe(true);
}

describe("PgStore 'error' on a checked-out client (#248)", () => {
  const cases = [
    {
      name: "getRun",
      hangOn: /FROM runs WHERE run_id/,
      call: (s: PgStore) => s.getRun("a"),
    },
    {
      name: "writeRun",
      hangOn: /^\s*INSERT INTO runs/,
      call: (s: PgStore) => s.writeRun({ run_id: "a", pr: PR, review: REVIEW, events: EVENTS }),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the emit does not throw, the call rejects, and the client is discarded`, async () => {
      const client = new FakeClient(c.hangOn);
      const { pool } = poolOf(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PgStore({ pool: pool as any });
      const inFlight = c.call(store);
      inFlight.catch(() => {});
      await untilWaiting(client);
      const err = terminated();
      // Unfixed: no listener, so this throws -- in production, out of a socket
      // callback, where nothing catches it and the process exits 1.
      expect(() => client.dropConnection(err)).not.toThrow();
      await expect(inFlight).rejects.toThrow("administrator command");
      // Released WITH the error, so pg-pool removes it instead of re-pooling it.
      expect(client.releasedWith).toEqual([err]);
      // Our listener is gone; after release the pool's idle listener owns errors.
      expect(client.listenerCount("error")).toBe(0);
    });

    it(`${c.name}: the next request on the same store succeeds`, async () => {
      const client = new FakeClient(c.hangOn);
      const { pool, handedOut } = poolOf(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PgStore({ pool: pool as any });
      const inFlight = c.call(store);
      inFlight.catch(() => {});
      await untilWaiting(client);
      client.dropConnection(terminated());
      await expect(inFlight).rejects.toThrow();
      await c.call(store); // a fresh client from the pool; resolves
      expect(handedOut).toHaveLength(2);
      expect(handedOut[1]?.releasedWith).toEqual([undefined]);
    });

    it(`control: ${c.name} on a healthy client releases it with no error and leaves no listener`, async () => {
      const client = new FakeClient(null);
      const { pool } = poolOf(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await c.call(new PgStore({ pool: pool as any }));
      expect(client.releasedWith).toEqual([undefined]);
      expect(client.listenerCount("error")).toBe(0);
    });
  }

  it("control: a query error that is not a connection error re-pools the client", async () => {
    // A rejected statement leaves the connection healthy; discarding it would
    // churn connections on every bad request.
    const client = new FakeClient(null);
    client.query = async (sql: string) => {
      if (/FROM runs WHERE run_id/.test(sql)) throw new Error("syntax error");
      return { rows: [] };
    };
    const { pool } = poolOf(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(new PgStore({ pool: pool as any }).getRun("a")).rejects.toThrow("syntax error");
    expect(client.releasedWith).toEqual([undefined]);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("control: an unlistened 'error' on a real pg Client throws (the crash mechanism)", async () => {
    const { Client } = (await import("pg" as unknown as string)) as {
      Client: new (cfg: { connectionString: string }) => EventEmitter;
    };
    const client = new Client({ connectionString: "postgresql://u:p@127.0.0.1:1/x" });
    expect(() => client.emit("error", terminated())).toThrow(/administrator command/);
  });
});
