/**
 * Concurrent first calls share ONE lazily built pool, and `close()` ends it
 * (#259).
 *
 * `getPool()` checked `this.pool`, awaited `import("pg")`, then built a Pool.
 * Every caller that arrived before the first assignment passed the check, so
 * each built its own Pool and `close()` ended only the last one. Measured on
 * Postgres 17: 5 concurrent first `listRuns()` opened 5 backends, `close()`
 * left 4, and the process exited ~9.4 s later on pg's idle timeout. Here the
 * real Pools are counted with their `query`/`end` stubbed, so no database is
 * needed.
 */
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PgStore } from "../../src/trace/pg-store.js";

// The Pools `PgStore` builds are real `pg` Pools, observed through the
// `pg-pool` class every `pg.Pool` extends (node loads it once, so these spies
// see the instances the store's own `import("pg")` builds). A `vi.mock("pg")`
// fake cannot count them: under vitest 1.x, concurrent first imports of a
// mocked module race its factory, and some get the real `pg` anyway.
// `query` and `end` are stubbed, so nothing connects.
//
// Resolved from `pg` itself, so it is the copy `pg` loads even if not hoisted.
const requireFromTest = createRequire(import.meta.url);
const PgPool = createRequire(requireFromTest.resolve("pg"))("pg-pool") as {
  prototype: { query(): Promise<unknown>; end(): Promise<void>; on(...args: unknown[]): unknown };
};

// Every Pool that served a query, and how many times each was ended.
let ended: Map<object, number>;

beforeEach(() => {
  ended = new Map();
  vi.spyOn(PgPool.prototype, "query").mockImplementation(async function (this: object) {
    // As pg-pool does after `end()`.
    if ((ended.get(this) ?? 0) > 0) throw new Error("Cannot use a pool after calling end on the pool");
    if (!ended.has(this)) ended.set(this, 0);
    return { rows: [] };
  });
  vi.spyOn(PgPool.prototype, "end").mockImplementation(async function (this: object) {
    ended.set(this, (ended.get(this) ?? 0) + 1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fresh = () => new PgStore({ connectionString: "postgresql://u:p@127.0.0.1:1/x" });

const counts = () => [...ended.values()];

describe("PgStore lazy pool init (#259)", () => {
  it("concurrent first calls build one Pool", async () => {
    const store = fresh();
    await Promise.all(Array.from({ length: 5 }, () => store.listRuns()));
    expect(ended.size).toBe(1);
    await store.close();
  });

  it("close() after concurrent first calls ends every Pool that served them", async () => {
    const store = fresh();
    await Promise.all(Array.from({ length: 5 }, () => store.listRuns()));
    await store.close();
    expect(ended.size).toBeGreaterThan(0);
    expect(counts()).toEqual(counts().map(() => 1));
  });

  it("close() while the first call is still building the pool ends that pool", async () => {
    const store = fresh();
    const inFlight = store.listRuns();
    await store.close();
    await Promise.allSettled([inFlight]);
    expect(counts()).toEqual([1]);
  });

  it("control: sequential calls reuse one Pool and close() ends it", async () => {
    const store = fresh();
    for (let i = 0; i < 5; i++) await store.listRuns();
    await store.close();
    expect(counts()).toEqual([1]);
  });

  it("control: a call after close() builds a fresh Pool", async () => {
    const store = fresh();
    await store.listRuns();
    await store.close();
    await store.listRuns();
    await store.close();
    expect(counts()).toEqual([1, 1]);
  });

  it("control: a failed build is not remembered; the next call retries", async () => {
    // `getPool` attaches its #242 'error' listener right after construction;
    // failing that once makes the first build reject.
    const EventEmitterOn = Object.getPrototypeOf(PgPool.prototype).on;
    let fail = true;
    vi.spyOn(PgPool.prototype, "on").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (fail) {
        fail = false;
        throw new Error("listener attach failed");
      }
      return EventEmitterOn.apply(this, args);
    });
    const store = fresh();
    await expect(store.listRuns()).rejects.toThrow("listener attach failed");
    await expect(store.listRuns()).resolves.toEqual([]);
    await store.close();
    expect(counts()).toEqual([1]);
  });

  it("control: a build that fails after close() does not forget the next build", async () => {
    const EventEmitterOn = Object.getPrototypeOf(PgPool.prototype).on;
    let fail = true;
    vi.spyOn(PgPool.prototype, "on").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (fail) {
        fail = false;
        throw new Error("listener attach failed");
      }
      return EventEmitterOn.apply(this, args);
    });
    const store = fresh();
    const doomed = store.listRuns();
    const closing = store.close();
    // Starts a second build while the first is still in flight; the first
    // one's failure must not clear it, or the next call builds a third Pool
    // and close() ends only that one.
    const second = store.listRuns();
    await Promise.allSettled([doomed, closing]);
    await second;
    await store.listRuns();
    await store.close();
    expect(counts()).toEqual([1]);
  });

  it("control: close() on a store that never built a pool is a no-op", async () => {
    await fresh().close();
    expect(ended.size).toBe(0);
  });
});
