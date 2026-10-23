/**
 * A timeout above Node's timer limit is refused up front, not clamped (#264).
 *
 * Node clamps any timer delay above 2^31-1 ms to 1 ms. `PgStore`'s
 * `connectionTimeoutMs` / `queryTimeoutMs` were checked only for finite and
 * positive, and `UpsertOptions.timeoutMs` went straight to
 * `AbortSignal.timeout`, so a huge value meant as "effectively no timeout"
 * made every request fail at once. Measured on origin/main 2192994: a
 * `timeoutMs` of 2147483648 aborted the sticky-comment call after 3 ms against
 * a stub that answers in 300 ms; 2147483647 waited and posted.
 *
 * No database needed: the PgStore arms use the construction-time throw.
 */
import { describe, expect, it, vi } from "vitest";

import { MAX_TIMER_MS } from "../src/agent/retry.js";
import { findStickyCommentId, STICKY_MARKER, upsertStickyComment } from "../src/eval/comment.js";
import { PgStore } from "../src/trace/pg-store.js";

const OVER = MAX_TIMER_MS + 1; // 2147483648

function okFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ id: 7 }),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("PgStore timeouts above the setTimeout limit (#264)", () => {
  it.each(["connectionTimeoutMs", "queryTimeoutMs"] as const)("refuses %s = 2147483648 at construction", (name) => {
    expect(() => new PgStore({ [name]: OVER })).toThrow(RangeError);
    expect(() => new PgStore({ [name]: OVER })).toThrow(
      `PgStore: ${name} must be <= 2147483647 (Node's setTimeout limit), got 2147483648`,
    );
  });

  // Controls: green before and after.
  it.each(["connectionTimeoutMs", "queryTimeoutMs"] as const)("accepts %s = 2147483647, the limit itself", (name) => {
    expect(() => new PgStore({ [name]: MAX_TIMER_MS })).not.toThrow();
  });

  it("keeps the existing message for a non-positive value", () => {
    expect(() => new PgStore({ connectionTimeoutMs: 0 })).toThrow(
      "PgStore: connectionTimeoutMs must be a positive finite number of ms, got 0",
    );
    expect(() => new PgStore({ queryTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(
      "PgStore: queryTimeoutMs must be a positive finite number of ms, got Infinity",
    );
  });
});

describe("sticky comment timeoutMs above the setTimeout limit (#264)", () => {
  const body = `report ${STICKY_MARKER}`;

  it("upsertStickyComment refuses 2147483648 before any fetch", async () => {
    const fetchImpl = okFetch();
    await expect(upsertStickyComment("o/r", 1, body, { token: "t", fetchImpl, timeoutMs: OVER })).rejects.toThrow(
      new RangeError(
        "UpsertOptions.timeoutMs must be <= 2147483647 (Node's setTimeout limit), got 2147483648. " +
          "A larger delay is silently clamped to 1 ms.",
      ),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("findStickyCommentId refuses 2147483648 before any fetch", async () => {
    const fetchImpl = okFetch();
    await expect(findStickyCommentId("o/r", 1, { token: "t", fetchImpl, timeoutMs: OVER })).rejects.toThrow(
      RangeError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Control: the limit itself still reaches GitHub.
  it("upsertStickyComment accepts 2147483647 and posts", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: Record<string, unknown>) => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => (init.method === "GET" ? [] : { id: 42 }),
    }));
    await expect(
      upsertStickyComment("o/r", 1, body, {
        token: "t",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: MAX_TIMER_MS,
      }),
    ).resolves.toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
