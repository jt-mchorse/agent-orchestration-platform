// `withRetry`'s backoff was unbounded by Node's setTimeout limit (#122).
//
// Node clamps any `setTimeout` delay above 2**31 - 1 to **1 ms** with a
// `TimeoutOverflowWarning` on stderr. Nothing in `validatePolicy` or the loop
// bounded the sleep by that limit, and two things in the file claimed otherwise:
//
//   1. `withRetry`'s docstring said "clamped by `backoffMaxMs`" — but
//      `backoffMaxMs` is OPTIONAL with no default, so the common case had no cap.
//   2. The in-loop comment said "The reported `backoffMs` is the actually-slept
//      value so the trace event matches reality (not the abstract formula)."
//
// Measured on `main` @ fc0c55b, Node v25.5.0:
//
//   A) no cap, { maxAttempts: 26, backoffMs: 1000, backoffMultiplier: 2 }:
//        attempt 22:  2097152000 ms   (fine)
//        attempt 23:  4194304000 ms   -> clamped to 1 ms
//        attempt 25: 16777216000 ms   -> clamped to 1 ms
//
//   B) cap set above the limit, raw always over the cap so the CAP is slept:
//        cap=2147483647  -> slept 2147483647 ms
//        cap=2147483648  -> slept 1 ms  (CLAMPED)
//        cap=3600000000  -> slept 1 ms  (CLAMPED)
//
//   C) the trace-fidelity claim:
//        backoffMs=1000        -> onAttempt reported 1000 ms,       wall 1003 ms  AGREES
//        backoffMs=3600000000  -> onAttempt reported 3600000000 ms, wall    0 ms  DISAGREES
//
// (C) is the one that matters most here: `onAttempt` is what the executor turns
// into `retry_attempted` events, which `PgStore.writeRun` persists and the trace
// UI renders. The trace claimed a 41.7-day backoff for something that took under
// a millisecond, in the repo whose whole point is a trustworthy trace.
//
// #29's `validatePolicy` sweep could not have caught any of this: it covered the
// numeric domain (integer, finite, sign), and every offending value here is
// finite and positive.

import { describe, expect, it, vi } from "vitest";
import { MAX_TIMER_MS, withRetry } from "../../src/agent/retry.js";
import { ToolError, type RetryPolicy } from "../../src/tools/types.js";

const flaky = async (): Promise<never> => {
  throw new ToolError("probe-tool", "internal", "transient");
};

/** Records the requested sleeps without waiting on real timers. */
function recordedSleep(): { sleeps: number[]; fn: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return { sleeps, fn: async (ms: number) => void sleeps.push(ms) };
}

describe("Node's setTimeout clamp is measured, not assumed (#122)", () => {
  it("a delay above MAX_TIMER_MS sleeps ~1 ms instead of ~24.8 days", async () => {
    // The premise of this whole issue. If a future Node changes it, the guards'
    // rationale changes with it and this test says so first.
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const started = Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, MAX_TIMER_MS + 1));
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      warn.mockRestore();
    }
  });

  it("MAX_TIMER_MS is exactly the 32-bit signed limit", () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
  });
});

describe("the trace event now agrees with reality (#122)", () => {
  it("onAttempt's reported backoffMs matches the real wall clock", async () => {
    // This is the property the in-loop comment claims, tested as a property
    // rather than trusting the comment. Deliberately uses the REAL sleep — a
    // recorded sleep would assert the reported number against itself.
    const reported: number[] = [];
    const started = Date.now();
    await expect(
      withRetry(flaky, { maxAttempts: 2, backoffMs: 120 }, (info) =>
        void reported.push(info.backoffMs),
      ),
    ).rejects.toThrow(ToolError);
    const wall = Date.now() - started;
    expect(reported).toEqual([120]);
    // Generous window — the point is that the two are in the same ballpark, not
    // that timers are precise.
    expect(wall).toBeGreaterThanOrEqual(100);
    expect(wall).toBeLessThan(2000);
  });

  it("the policy that made them disagree can no longer be constructed", async () => {
    // Pre-fix: reported 3600000000 ms, wall clock 0 ms. There is no reporting
    // fix here — the schedule guard makes the clamp unreachable, so the number
    // and the sleep agree by construction.
    const onAttempt = vi.fn();
    await expect(
      withRetry(flaky, { maxAttempts: 2, backoffMs: 3_600_000_000 }, onAttempt),
    ).rejects.toThrow(/backoffMs must be <= 2147483647/);
    expect(onAttempt).not.toHaveBeenCalled();
  });
});

describe("backoffMs / backoffMaxMs upper bound (#122)", () => {
  it.each([
    { field: "backoffMs", value: MAX_TIMER_MS + 1 },
    { field: "backoffMs", value: 3_600_000_000 },
    { field: "backoffMs", value: 1e308 },
    { field: "backoffMaxMs", value: MAX_TIMER_MS + 1 },
    { field: "backoffMaxMs", value: 3_600_000_000 },
  ])("rejects $field = $value", async ({ field, value }) => {
    const policy = { maxAttempts: 3, backoffMs: 1000, [field]: value } as unknown as RetryPolicy;
    await expect(withRetry(flaky, policy)).rejects.toThrow(
      new RegExp(`RetryPolicy\\.${field} must be <= 2147483647`),
    );
  });

  it("the message says what the harm is, not just the rule", async () => {
    await expect(
      withRetry(flaky, { maxAttempts: 2, backoffMs: 3_600_000_000 }),
    ).rejects.toThrow(/silently clamped to 1 ms, abandoning the backoff schedule/);
  });

  it("backoffMaxMs needs the bound because it is the value actually slept", async () => {
    // Measured pre-fix with the raw exponential always exceeding the cap:
    // cap 2147483647 slept 2147483647 ms; cap 2147483648 slept 1 ms. A cap above
    // the limit is a cap that does not protect, which is why it is bounded too.
    const sleep = recordedSleep();
    await expect(
      withRetry(
        flaky,
        { maxAttempts: 3, backoffMs: 1e9, backoffMaxMs: MAX_TIMER_MS, backoffMultiplier: 10 },
        () => {},
        sleep.fn,
      ),
    ).rejects.toThrow(ToolError);
    expect(Math.max(...sleep.sleeps)).toBe(MAX_TIMER_MS);
    expect(Math.max(...sleep.sleeps)).toBeLessThanOrEqual(MAX_TIMER_MS);
  });

  it("exactly MAX_TIMER_MS is still accepted for both fields", async () => {
    // Inclusive boundary: 2147483647 really does sleep 2147483647 ms.
    await expect(withRetry(async () => "ok", { maxAttempts: 1, backoffMs: MAX_TIMER_MS })).resolves.toBe(
      "ok",
    );
    await expect(
      withRetry(async () => "ok", {
        maxAttempts: 2,
        backoffMs: 1000,
        backoffMaxMs: MAX_TIMER_MS,
      }),
    ).resolves.toBe("ok");
  });
});

describe("the whole schedule is bounded at the boundary (#122)", () => {
  it("an overflowing schedule is rejected before fn runs once", async () => {
    // Mid-loop rejection would be worse than the bug: it would turn a retryable
    // ToolError into a hard failure inside a budget the caller committed to.
    const fn = vi.fn(flaky);
    await expect(
      withRetry(fn, { maxAttempts: 26, backoffMs: 1000, backoffMultiplier: 2 }),
    ).rejects.toThrow(/backoff schedule exceeds Node's setTimeout limit/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("the message names the offending attempt and every input", async () => {
    // maxAttempts 26 -> peak at attempt 25, exponent 24: 1000 * 2^24 = 16777216000.
    await expect(
      withRetry(flaky, { maxAttempts: 26, backoffMs: 1000, backoffMultiplier: 2 }),
    ).rejects.toThrow(/attempt 25 would sleep 16777216000 ms/);
    await expect(
      withRetry(flaky, { maxAttempts: 26, backoffMs: 1000, backoffMultiplier: 2 }),
    ).rejects.toThrow(/maxAttempts \(26\).*backoffMs \(1000\).*backoffMultiplier \(2\)/);
  });

  it("the boundary between accepted and rejected is exact", async () => {
    // 23 attempts -> peak exponent 21 -> 2097152000, in range.
    // 24 attempts -> peak exponent 22 -> 4194304000, over.
    const noSleep = async (): Promise<void> => {};
    await expect(
      withRetry(flaky, { maxAttempts: 23, backoffMs: 1000, backoffMultiplier: 2 }, () => {}, noSleep),
    ).rejects.toThrow(ToolError);
    await expect(
      withRetry(flaky, { maxAttempts: 24, backoffMs: 1000, backoffMultiplier: 2 }, () => {}, noSleep),
    ).rejects.toThrow(/backoff schedule exceeds/);
  });

  it("A VALID backoffMaxMs keeps a high maxAttempts accepted", async () => {
    // The case the fix must not break, and the reason the guard applies the cap
    // exactly as the loop does rather than checking the raw exponential alone.
    // 26 attempts at 1000ms x2 overflows raw, but a 60s cap genuinely bounds it.
    const sleep = recordedSleep();
    await expect(
      withRetry(
        flaky,
        { maxAttempts: 26, backoffMs: 1000, backoffMultiplier: 2, backoffMaxMs: 60_000 },
        () => {},
        sleep.fn,
      ),
    ).rejects.toThrow(ToolError);
    expect(sleep.sleeps).toHaveLength(25);
    expect(Math.max(...sleep.sleeps)).toBe(60_000);
  });

  it("maxAttempts = 1 never sleeps, so no in-range backoffMs can overflow it", async () => {
    await expect(
      withRetry(async () => "ok", { maxAttempts: 1, backoffMs: MAX_TIMER_MS, backoffMultiplier: 2 }),
    ).resolves.toBe("ok");
  });
});

describe("what must not change (#122)", () => {
  it("the existing finiteness and sign messages are preserved", async () => {
    // test/agent/retry.test.ts matches on these strings; the new bounds are
    // separate branches with their own messages so both stay distinct.
    await expect(withRetry(flaky, { maxAttempts: 0, backoffMs: 10 })).rejects.toThrow(
      /maxAttempts must be an integer >= 1/,
    );
    await expect(withRetry(flaky, { maxAttempts: 3, backoffMs: Number.NaN })).rejects.toThrow(
      /backoffMs must be a finite number >= 0/,
    );
    await expect(
      withRetry(flaky, { maxAttempts: 3, backoffMs: 10, backoffMaxMs: -1 }),
    ).rejects.toThrow(/backoffMaxMs must be a finite number >= 0/);
    await expect(
      withRetry(flaky, { maxAttempts: 3, backoffMs: 10, backoffMultiplier: 0.5 }),
    ).rejects.toThrow(/backoffMultiplier must be a finite number >= 1.0/);
  });

  it("an ordinary policy's schedule is unchanged", async () => {
    const sleep = recordedSleep();
    await expect(
      withRetry(flaky, { maxAttempts: 4, backoffMs: 10, backoffMultiplier: 3 }, () => {}, sleep.fn),
    ).rejects.toThrow(ToolError);
    expect(sleep.sleeps).toEqual([10, 30, 90]);
  });

  it("a non-retryable ToolError still short-circuits before any sleep", async () => {
    const sleep = recordedSleep();
    const fn = vi.fn(async () => {
      throw new ToolError("probe-tool", "not_found", "nope");
    });
    await expect(
      withRetry(fn, { maxAttempts: 5, backoffMs: 10 }, () => {}, sleep.fn),
    ).rejects.toThrow(/not_found/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep.sleeps).toEqual([]);
  });
});
