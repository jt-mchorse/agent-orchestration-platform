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

  // Pre-#29 this test pinned a silent `Math.max(1, maxAttempts)` clamp.
  // The clamp is gone — `maxAttempts < 1` now throws RangeError at the
  // validation step (see "withRetry — RetryPolicy validation" block).
  // Per-field rejection tests live in that block; this slot is intentionally
  // retired so the abort-paths suite no longer documents the old behavior.
});

describe("DEFAULT_RETRYABLE_KINDS", () => {
  it("retries internal failures and nothing else by default", () => {
    // Sanity-check that the default doesn't quietly include validation kinds.
    expect(DEFAULT_RETRYABLE_KINDS).toEqual(["internal"]);
  });
});

describe("withRetry — backoffMaxMs cap (issue #25)", () => {
  it("clamps the computed backoff at backoffMaxMs", async () => {
    const sleep = makeRecordedSleep();
    let n = 0;
    const policy: RetryPolicy = {
      maxAttempts: 5,
      backoffMs: 100,
      backoffMultiplier: 4.0,
      // Without cap: 100, 400, 1600, 6400 ms. With cap=500: 100, 400, 500, 500.
      backoffMaxMs: 500,
    };
    try {
      await withRetry(
        async () => {
          n += 1;
          throw new ToolError("flaky", "internal", `failure ${n}`);
        },
        policy,
        () => {},
        sleep.fn,
      );
    } catch {
      /* expected to throw after maxAttempts */
    }
    expect(n).toBe(5);
    expect(sleep.sleeps).toEqual([100, 400, 500, 500]);
  });

  it("undefined backoffMaxMs preserves unbounded growth", async () => {
    const sleep = makeRecordedSleep();
    let n = 0;
    const policy: RetryPolicy = {
      maxAttempts: 3,
      backoffMs: 100,
      backoffMultiplier: 4.0,
    };
    try {
      await withRetry(
        async () => {
          n += 1;
          throw new ToolError("flaky", "internal", `failure ${n}`);
        },
        policy,
        () => {},
        sleep.fn,
      );
    } catch {
      /* expected */
    }
    expect(sleep.sleeps).toEqual([100, 400]);
  });
});

describe("withRetry — full jitter (issue #25)", () => {
  it("full jitter draws sleeps in [0, capped] using the injected random", async () => {
    const sleep = makeRecordedSleep();
    // Pinned random sequence: 0.0 (drives sleep to 0), 0.5 (half), 0.99 (~full).
    const randoms = [0.0, 0.5, 0.99];
    let idx = 0;
    const random = () => randoms[idx++] as number;
    let n = 0;
    const policy: RetryPolicy = {
      maxAttempts: 4,
      backoffMs: 100,
      backoffMultiplier: 2.0,
      // Cap holds back: 100, 200, 400 — all under 1000.
      backoffMaxMs: 1000,
      jitter: "full",
    };
    try {
      await withRetry(
        async () => {
          n += 1;
          throw new ToolError("flaky", "internal", `failure ${n}`);
        },
        policy,
        () => {},
        sleep.fn,
        random,
      );
    } catch {
      /* expected */
    }
    // backoff sequence (capped) is [100, 200, 400]; full jitter applies factor:
    // 100*0.0=0, 200*0.5=100, 400*0.99=396.
    expect(sleep.sleeps).toEqual([0, 100, 400 * 0.99]);
  });

  it("'none' (default) is exact deterministic sleep — regression guard", async () => {
    const sleep = makeRecordedSleep();
    let n = 0;
    const policy: RetryPolicy = {
      maxAttempts: 3,
      backoffMs: 100,
      backoffMultiplier: 2.0,
      // omit backoffMaxMs and jitter — both new fields should default to current
      // behavior, so this test is byte-identical to a pre-issue invocation.
    };
    try {
      await withRetry(
        async () => {
          n += 1;
          throw new ToolError("flaky", "internal", `failure ${n}`);
        },
        policy,
        () => {},
        sleep.fn,
      );
    } catch {
      /* expected */
    }
    expect(sleep.sleeps).toEqual([100, 200]);
  });
});

describe("withRetry — onAttempt reports actually-slept backoffMs (issue #25)", () => {
  it("onAttempt.backoffMs reflects cap + jitter, not the abstract formula", async () => {
    const sleep = makeRecordedSleep();
    const reported: number[] = [];
    // Pinned random to make the assertion deterministic.
    let n = 0;
    const policy: RetryPolicy = {
      maxAttempts: 4,
      backoffMs: 100,
      backoffMultiplier: 10.0, // grows fast: 100, 1000, 10000
      backoffMaxMs: 500, // capped to 500
      jitter: "full",
    };
    try {
      await withRetry(
        async () => {
          n += 1;
          throw new ToolError("flaky", "internal", `failure ${n}`);
        },
        policy,
        (info) => reported.push(info.backoffMs),
        sleep.fn,
        () => 1.0, // jitter factor = 1.0 → keeps capped value
      );
    } catch {
      /* expected */
    }
    // The formula would say [100, 1000, 10000]; the actually-slept sequence
    // (after cap, with jitter=1.0) is [100, 500, 500]. Reported must match.
    expect(reported).toEqual([100, 500, 500]);
    expect(reported).toEqual(sleep.sleeps);
  });
});

// Issue #29: validate RetryPolicy at the entry of withRetry. Pre-#29 invalid
// numerics were silently absorbed by Math.max(1, …) and setTimeout's negative
// coercion, masking operator misconfig. NaN for maxAttempts made the loop
// never execute, and `throw lastError` surfaced `undefined` instead of an
// error.
describe("withRetry — RetryPolicy validation (issue #29)", () => {
  const sleep = makeRecordedSleep();
  const noopFn = async () => "ok";

  it.each([
    { value: 0, label: "zero" },
    { value: -1, label: "negative" },
    { value: 1.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
  ])("rejects maxAttempts $label ($value)", async ({ value }) => {
    const policy: RetryPolicy = { maxAttempts: value, backoffMs: 10 };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).rejects.toThrow(
      /maxAttempts must be an integer >= 1/,
    );
  });

  it("accepts maxAttempts = 1 (minimum valid; no retries)", async () => {
    const policy: RetryPolicy = { maxAttempts: 1, backoffMs: 0 };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).resolves.toBe("ok");
  });

  it.each([
    { value: -1, label: "negative" },
    { value: -0.5, label: "negative-fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
  ])("rejects backoffMs $label ($value)", async ({ value }) => {
    const policy: RetryPolicy = { maxAttempts: 3, backoffMs: value };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).rejects.toThrow(
      /backoffMs must be a finite number >= 0/,
    );
  });

  it("accepts backoffMs = 0 (minimum valid)", async () => {
    const policy: RetryPolicy = { maxAttempts: 2, backoffMs: 0 };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).resolves.toBe("ok");
  });

  it.each([
    { value: -1, label: "negative" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
  ])("rejects backoffMaxMs $label ($value)", async ({ value }) => {
    const policy: RetryPolicy = { maxAttempts: 3, backoffMs: 10, backoffMaxMs: value };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).rejects.toThrow(
      /backoffMaxMs must be a finite number >= 0/,
    );
  });

  it("accepts backoffMaxMs = 0 (clamps every attempt to 0; aggressive but valid)", async () => {
    const policy: RetryPolicy = { maxAttempts: 2, backoffMs: 10, backoffMaxMs: 0 };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).resolves.toBe("ok");
  });

  it("accepts undefined backoffMaxMs (unbounded growth preserved)", async () => {
    const policy: RetryPolicy = { maxAttempts: 2, backoffMs: 10 };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).resolves.toBe("ok");
  });

  it.each([
    { value: 0, label: "zero" },
    { value: 0.5, label: "shrinking <1.0" },
    { value: -1, label: "negative" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
  ])("rejects backoffMultiplier $label ($value)", async ({ value }) => {
    const policy: RetryPolicy = {
      maxAttempts: 3,
      backoffMs: 10,
      backoffMultiplier: value,
    };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).rejects.toThrow(
      /backoffMultiplier must be a finite number >= 1\.0/,
    );
  });

  it("accepts backoffMultiplier = 1.0 (fixed-interval retry, per docstring)", async () => {
    const policy: RetryPolicy = {
      maxAttempts: 2,
      backoffMs: 10,
      backoffMultiplier: 1.0,
    };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).resolves.toBe("ok");
  });

  it("accepts undefined backoffMultiplier (defaults to 2.0)", async () => {
    const policy: RetryPolicy = { maxAttempts: 2, backoffMs: 10 };
    await expect(withRetry(noopFn, policy, () => {}, sleep.fn)).resolves.toBe("ok");
  });

  it("validation runs before fn() is invoked even once (proves it's at entry)", async () => {
    const fn = vi.fn(async () => "should not reach");
    const policy: RetryPolicy = { maxAttempts: 0, backoffMs: 10 };
    await expect(withRetry(fn, policy, () => {}, sleep.fn)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});
