/**
 * `run_id` must be a value the `runs.run_id TEXT` column holds as itself (#209).
 *
 * `run_id` reaches Postgres only as a `TEXT` parameter, never inside an event
 * payload, and nothing matched it to that column the way D-016 matched
 * `pr_number`. Measured on Postgres 17 before the fix:
 *
 *     id                     MemoryStore            PgStore
 *     "x" + U+D800           stored as itself       stored as "x" + U+FFFD
 *     then "x" + U+DC00      a second run           SAME ROW: replaced the first run
 *     "abc" + U+0000 + "def" stored                 22021 on writeRun AND getRun
 *     GET /api/runs/abc%00def  404                  500
 *
 * Ids are built from code points, never literals (a raw NUL in this file would
 * also trip test/no-raw-control-bytes-in-source.test.ts).
 *
 * Two arms are green on both trees and are what reject the wrong neighbours:
 * `a well-formed astral pair is still a legal id` (a surrogate range check
 * without the `u` flag refuses every emoji) and `an ordinary getRun still
 * queries` (a getRun that short-circuits too much).
 */
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { TraceEvent } from "../../src/agent/trace.js";
import { PgStore } from "../../src/trace/pg-store.js";
import { MemoryStore, type WriteRunInput } from "../../src/trace/store.js";
import { createTraceServer } from "../../src/ui/server.js";

const NUL = String.fromCharCode(0);
const LONE_HI = String.fromCharCode(0xd800);
const LONE_LO = String.fromCharCode(0xdc00);
const ASTRAL = String.fromCodePoint(0x1f600); // a well-formed surrogate pair
const REPLACEMENT = String.fromCharCode(0xfffd);

const BAD_IDS: Array<[string, string]> = [
  ["a lone high surrogate", "run-" + LONE_HI],
  ["a lone low surrogate", "run-" + LONE_LO],
  ["a reversed pair", "run-" + LONE_LO + LONE_HI],
  ["U+0000", "abc" + NUL + "def"],
];

function run(runId: string): WriteRunInput {
  const pr = { owner: "o", repo: "r", number: 1 };
  const events: TraceEvent[] = [
    { ts: 1_700_000_000_000, kind: "run_started", pr },
    { ts: 1_700_000_000_001, kind: "finalized", review: { summary: "s", findings: [], recommendation: "approve" } },
  ];
  return { run_id: runId, pr, events, review: { summary: "s", findings: [], recommendation: "approve" } };
}

/**
 * A pool that records every statement and, like Postgres, refuses a parameter
 * holding U+0000 (`22021`). It answers SELECTs with no rows.
 */
function recordingPool() {
  const queries: string[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    queries.push(text.trim().split(/\s+/)[0] ?? "");
    if (params.some((p) => typeof p === "string" && p.includes(NUL))) {
      throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
    }
    return { rows: [] };
  };
  return {
    queries,
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
      end: async () => {},
    },
  };
}

describe("both writeRuns refuse a run_id the TEXT column cannot hold", () => {
  for (const [label, id] of BAD_IDS) {
    it(`MemoryStore: ${label}`, async () => {
      const store = new MemoryStore();
      await expect(store.writeRun(run(id))).rejects.toThrow(/run_id must not contain/);
      // Refused, not stored: a run under an altered id is worse than none.
      expect(await store.getRun(id)).toBeNull();
      expect(await store.listRuns()).toEqual([]);
    });

    it(`PgStore: ${label}, before any statement is sent`, async () => {
      const { pool, queries } = recordingPool();
      const store = new PgStore({ pool });
      await expect(store.writeRun(run(id))).rejects.toThrow(TypeError);
      expect(queries).toEqual([]);
    });
  }

  it("the two lone halves no longer collapse into one stored run", async () => {
    // The collision itself, on the backend that has it in-process: every id the
    // store accepts must be one Postgres stores as itself.
    const store = new MemoryStore();
    for (const id of ["x" + LONE_HI, "x" + LONE_LO]) {
      await store.writeRun(run(id)).catch(() => {});
    }
    expect((await store.listRuns()).map((r) => r.run_id)).toEqual([]);
  });
});

describe("getRun answers null for such an id on both backends", () => {
  for (const [label, id] of BAD_IDS) {
    it(`PgStore: ${label}, without querying`, async () => {
      const { pool, queries } = recordingPool();
      const store = new PgStore({ pool });
      expect(await store.getRun(id)).toBeNull();
      expect(queries).toEqual([]);
    });
  }

  it("an ordinary getRun still queries", async () => {
    const { pool, queries } = recordingPool();
    expect(await new PgStore({ pool }).getRun("run-1")).toBeNull();
    expect(queries).toEqual(["SELECT"]);
  });
});

describe("green on both trees: what the guard must still accept", () => {
  it("a well-formed astral pair, U+FFFD itself, and an empty id are legal ids", async () => {
    const store = new MemoryStore();
    for (const id of ["run-" + ASTRAL, "run-" + REPLACEMENT, ""]) {
      await store.writeRun(run(id));
      expect((await store.getRun(id))?.run_id).toBe(id);
    }
  });
});

describe("the trace server", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  async function status(store: MemoryStore | PgStore, urlPath: string): Promise<number> {
    server = createTraceServer({ store });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    return (await fetch(`http://127.0.0.1:${port}${urlPath}`)).status;
  }

  it("GET /api/runs/abc%00def is a 404 on PgStore, as on MemoryStore", async () => {
    // #117 / #155: a hand-typed URL is never a 500.
    expect(await status(new MemoryStore(), "/api/runs/abc%00def")).toBe(404);
    expect(await status(new PgStore({ pool: recordingPool().pool }), "/api/runs/abc%00def")).toBe(404);
  });
});
