import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRYABLE_KINDS, withRetry } from "../../src/agent/retry.js";
import { ToolError, type RetryPolicy } from "../../src/tools/types.js";

/**
 * Recorded-no-op sleep so the suite doesn't wait on real timers. The
 * sleep function is passed the requested backoffMs so individual tests
 * can assert the backoff schedule.
 */
function makeRecordedSleep(): { sleeps: number[]; fn: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    fn: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("withRetry — happy paths", () => {
  it("returns the value on first success without sleeping", async () => {
    const sleep = makeRecordedSleep();
    const policy: RetryPolicy = { maxAttempts: 3, backoffMs: 10 };
    const result = await withRetry(async () => 42, policy, () => {}, sleep.fn);
    expect(result).toBe(42);
    expect(sleep.sleeps).toEqual([]);
  });

  it("retries a retryable error and returns the eventual success", async () => {
    const sleep = makeRecordedSleep();
    const attempts: number[] = [];
    let n = 0;
    const policy: RetryPolicy = { maxAttempts: 3, backoffMs: 5 };

    const result = await withRetry(
      async () => {
        n += 1;
        if (n < 3) {
          throw new ToolError("flaky", "internal", `failure ${n}`);
        }
        return "ok";
      },
      policy,
      (info) => attempts.push(info.attempt),
      sleep.fn,
    );

    expect(result).toBe("ok");
    expect(n).toBe(3);
    expect(attempts).toEqual([1, 2]);
    // Exponential backoff with default multiplier 2.0: 5 then 10.
    expect(sleep.sleeps).toEqual([5, 10]);
  });

  it("applies the configured backoffMultiplier to the schedule", async () => {
    const sleep = makeRecordedSleep();
    let n = 0;
    const policy: RetryPolicy = {
      maxAttempts: 4,
      backoffMs: 1,
      backoffMultiplier: 3,
    };

    await withRetry(
      async () => {
        n += 1;
        if (n < 4) throw new ToolError("flaky", "internal", "boom");
        return "ok";
      },
      policy,
      () => {},
      sleep.fn,
    );

    // 1 * 3^0, 3^1, 3^2 = 1, 3, 9
    expect(sleep.sleeps).toEqual([1, 3, 9]);
  });
});

describe("withRetry — abort paths", () => {
  it("does not retry non-ToolError exceptions (programmer bugs)", async () => {
    const sleep = makeRecordedSleep();
    const policy: RetryPolicy = { maxAttempts: 5, backoffMs: 1 };
    const fn = vi.fn(async () => {
      throw new Error("plain bug");
    });

    await expect(withRetry(fn, policy, () => {}, sleep.fn)).rejects.toThrow(/plain bug/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep.sleeps).toEqual([]);
  });

  it("does not retry non-retryable ToolError kinds by default", async () => {
    const sleep = makeRecordedSleep();
    const policy: RetryPolicy = { maxAttempts: 5, backoffMs: 1 };
    const fn = vi.fn(async () => {
      throw new ToolError("v", "input_validation", "bad input");
    });

    await expect(withRetry(fn, policy, () => {}, sleep.fn)).rejects.toMatchObject({
      kind: "input_validation",
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep.sleeps).toEqual([]);
  });

  it("retries a custom kind when retryableErrorKinds is overridden", async () => {
    const sleep = makeRecordedSleep();
    let n = 0;
    const policy: RetryPolicy = {
      maxAttempts: 3,
      backoffMs: 1,
      retryableErrorKinds: ["not_found"],
    };

    const result = await withRetry(
      async () => {
        n += 1;
        if (n < 2) throw new ToolError("x", "not_found", "missing");
        return "ok";
      },
      policy,
      () => {},
      sleep.fn,
    );

    expect(result).toBe("ok");
    expect(n).toBe(2);
  });

  it("surfaces the final error when maxAttempts is exhausted", async () => {
    const sleep = makeRecordedSleep();
    const policy: RetryPolicy = { maxAttempts: 3, backoffMs: 1 };
    const fn = vi.fn(async () => {
      throw new ToolError("flaky", "internal", "never recovers");
    });

    await expect(withRetry(fn, policy, () => {}, sleep.fn)).rejects.toMatchObject({
      kind: "internal",
      toolName: "flaky",
    });
    // 3 attempts total: 1 success try + 2 retries; we should see 2 sleeps
    // because the last failure short-circuits without sleeping.
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.sleeps).toHaveLength(2);
  });

  it("clamps maxAttempts < 1 to a single attempt", async () => {
    const sleep = makeRecordedSleep();
    const policy: RetryPolicy = { maxAttempts: 0, backoffMs: 1 };
    const fn = vi.fn(async () => "value");

    const result = await withRetry(fn, policy, () => {}, sleep.fn);
    expect(result).toBe("value");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("DEFAULT_RETRYABLE_KINDS", () => {
  it("retries internal failures and nothing else by default", () => {
    // Sanity-check that the default doesn't quietly include validation kinds.
    expect(DEFAULT_RETRYABLE_KINDS).toEqual(["internal"]);
  });
});
