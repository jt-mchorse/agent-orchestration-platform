import { ToolError, type RetryPolicy, type ToolErrorKind } from "../tools/types.js";

/**
 * Default set of `ToolError` kinds that the retry helper treats as
 * transient. The motivation per kind:
 * - `internal`: catches "the tool's own runtime barfed" — flaky network,
 *   intermittent service failure, etc. These are the canonical
 *   retry-eligible failures and a real Anthropic SDK call would commonly
 *   surface as one.
 *
 * Kinds that are deliberately not retried by default:
 * - `input_validation`, `output_validation`: deterministic per input; a
 *   second attempt with the same input is guaranteed to fail.
 * - `not_found`: a missing tool isn't going to appear on a retry.
 * - `unsupported_in_live`: live-mode stub, not a transient failure
 *   (wiring isn't going to materialize on a retry).
 * - `approval_denied`, `approval_missing`: human/runtime decision; not
 *   for the retry layer to second-guess.
 *
 * Tool authors can override via `RetryPolicy.retryableErrorKinds`.
 */
export const DEFAULT_RETRYABLE_KINDS: readonly ToolErrorKind[] = ["internal"] as const;

/** One observed failure during a retried call. */
export interface RetryAttempt {
  /** 1-indexed attempt number that just failed (so 1 = first failure). */
  attempt: number;
  /** Milliseconds the helper will sleep before the next attempt. */
  backoffMs: number;
  /** The `ToolError` that triggered the retry. */
  error: ToolError;
}

/** Callback fired after every failure that *will* be retried. */
export type OnRetryAttempt = (info: RetryAttempt) => void;

/** Sleep abstraction so tests can run synchronously with a fake clock. */
export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Random-number abstraction so tests can pin jitter deterministically.
 * Returns a float in `[0, 1)`, same contract as `Math.random`.
 */
export type RandomFn = () => number;

const realRandom: RandomFn = Math.random;

/**
 * The largest delay Node's `setTimeout` can represent (a 32-bit signed int of
 * milliseconds, ~24.8 days). Anything above it is silently clamped to **1 ms**
 * with a `TimeoutOverflowWarning` on stderr. See `validatePolicy` for what that
 * costs here (#122).
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Run an async function with retry-on-`ToolError`.
 *
 * Semantics:
 * - On success, returns the value immediately.
 * - On a `ToolError` whose `kind` is in the policy's retryable set, calls
 *   `onAttempt` with the failure info, sleeps `backoffMs * mult^(n-1)`
 *   (capped by `backoffMaxMs` *when supplied* — it is optional and has no
 *   default, so an omitted cap means the raw exponential; optionally jittered
 *   per `jitter`), and tries again. Up to `maxAttempts` total attempts.
 *
 *   This used to read "clamped by `backoffMaxMs`" without the caveat, which
 *   read as though a cap always applied. It does not, and that is how an
 *   unbounded schedule reached `setTimeout` (#122). `validatePolicy` now
 *   rejects any policy whose peak sleep would exceed `MAX_TIMER_MS`, capped or
 *   not, so the sleep is always a value `setTimeout` can actually represent.
 * - On a non-`ToolError` throw (programmer bug) or a `ToolError` whose
 *   `kind` is non-retryable, propagates the original error immediately.
 *
 * The helper is intentionally pure — it knows nothing about the trace,
 * the registry, or the agent's planner. The executor wires the
 * `onAttempt` callback to emit `retry_attempted` events.
 *
 * The `random` injection point lets tests pin jitter for deterministic
 * assertions; default is `Math.random`.
 */
/**
 * Validate a `RetryPolicy` at the entry of `withRetry`.
 *
 * Each invalid numeric throws `RangeError` naming the offending field and
 * received value. Pre-#29 the runtime did `Math.max(1, maxAttempts)` and
 * accepted negative/`NaN`/non-finite inputs for everything else — `NaN`
 * for `maxAttempts` made the for-loop never execute and `throw lastError`
 * surfaced `undefined`; negative backoffs were coerced to `0` by
 * `setTimeout`, silently undoing the operator's intended schedule.
 *
 * Mirrors the portfolio's contract-tightening sweep (eval-harness #40,
 * cost-optimizer #34, rag-kit #36, emb-shootout #29, vector-search #27,
 * chunking-lab #27, prompt-regression #35): operator-supplied numeric
 * inputs validated at the entry site with a loud error rather than
 * silent degeneracy.
 */
function validatePolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(
      `RetryPolicy.maxAttempts must be an integer >= 1; got ${policy.maxAttempts}`,
    );
  }
  if (!Number.isFinite(policy.backoffMs) || policy.backoffMs < 0) {
    throw new RangeError(
      `RetryPolicy.backoffMs must be a finite number >= 0; got ${policy.backoffMs}`,
    );
  }
  if (policy.backoffMaxMs !== undefined) {
    if (!Number.isFinite(policy.backoffMaxMs) || policy.backoffMaxMs < 0) {
      throw new RangeError(
        `RetryPolicy.backoffMaxMs must be a finite number >= 0; got ${policy.backoffMaxMs}`,
      );
    }
  }
  if (policy.backoffMultiplier !== undefined) {
    if (!Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier < 1.0) {
      throw new RangeError(
        `RetryPolicy.backoffMultiplier must be a finite number >= 1.0; got ${policy.backoffMultiplier}`,
      );
    }
  }
  // Timer-limit bounds (#122). #29's sweep was over the NUMERIC DOMAIN —
  // integer, finite, sign — and every value this closes is finite and positive,
  // so that sweep structurally could not see it. Node clamps any `setTimeout`
  // delay above `MAX_TIMER_MS` to 1 ms, which does not merely shorten the
  // backoff, it abandons the schedule: a retryable failure gets hammered
  // `maxAttempts` times in a few milliseconds. Measured:
  //
  //   backoffMs = 2147483647  -> real sleep 2147483647 ms
  //   backoffMs = 2147483648  -> real sleep 1 ms  (CLAMPED)
  //   backoffMs = 3600000000  -> real sleep 1 ms  (CLAMPED)
  //
  // `backoffMaxMs` needs the same bound, because it is the value that is
  // actually slept once the raw exponential exceeds it — so a cap set above the
  // limit is a cap that does not protect. Measured with the raw value always
  // over the cap: cap 2147483647 slept 2147483647 ms, cap 2147483648 slept 1 ms.
  for (const [name, value] of [
    ["backoffMs", policy.backoffMs],
    ["backoffMaxMs", policy.backoffMaxMs],
  ] as const) {
    if (value !== undefined && value > MAX_TIMER_MS) {
      throw new RangeError(
        `RetryPolicy.${name} must be <= ${MAX_TIMER_MS} (Node's setTimeout limit); ` +
          `got ${value}. A larger delay is silently clamped to 1 ms, abandoning ` +
          `the backoff schedule.`,
      );
    }
  }
  // And the schedule as a whole. The value that reaches `setTimeout` is derived
  // from all four fields above and was checked by none of them: with entirely
  // ordinary inputs (`backoffMs: 1000`, `backoffMultiplier: 2`, no cap) attempt
  // 22 sleeps 2097152000 ms and attempt 23 sleeps 1 ms — an exponential
  // schedule silently becoming a tight loop.
  //
  // Checked HERE, not mid-loop, for the reason every guard above gives: a
  // mid-retry throw would turn a retryable `ToolError` into a hard failure
  // inside a budget the caller had already committed to. The peak sleep is at
  // `attempt = maxAttempts - 1` (the final attempt throws instead of sleeping),
  // so the peak exponent is `maxAttempts - 2`; `maxAttempts <= 1` never sleeps.
  //
  // A policy with a VALID `backoffMaxMs` stays accepted at any `maxAttempts` —
  // the cap genuinely bounds the sleep, and rejecting that would break working
  // configurations. That is why the cap is applied here exactly as the loop
  // applies it, rather than checking the raw exponential alone.
  if (policy.maxAttempts >= 2) {
    const multiplier = policy.backoffMultiplier ?? 2.0;
    const rawPeak = policy.backoffMs * multiplier ** (policy.maxAttempts - 2);
    const peak =
      policy.backoffMaxMs !== undefined ? Math.min(rawPeak, policy.backoffMaxMs) : rawPeak;
    if (peak > MAX_TIMER_MS) {
      throw new RangeError(
        `RetryPolicy's backoff schedule exceeds Node's setTimeout limit: attempt ` +
          `${policy.maxAttempts - 1} would sleep ${peak} ms, above ${MAX_TIMER_MS}, ` +
          `which is silently clamped to 1 ms. Lower maxAttempts ` +
          `(${policy.maxAttempts}) or backoffMs (${policy.backoffMs}), reduce ` +
          `backoffMultiplier (${multiplier}), or set backoffMaxMs.`,
      );
    }
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onAttempt: OnRetryAttempt = () => {},
  sleep: SleepFn = realSleep,
  random: RandomFn = realRandom,
): Promise<T> {
  validatePolicy(policy);
  const maxAttempts = policy.maxAttempts;
  const multiplier = policy.backoffMultiplier ?? 2.0;
  const retryable = new Set<ToolErrorKind>(
    policy.retryableErrorKinds ?? DEFAULT_RETRYABLE_KINDS,
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof ToolError)) {
        // Programmer bug — don't swallow into a retry loop.
        throw err;
      }
      const moreAttemptsLeft = attempt < maxAttempts;
      const kindIsRetryable = retryable.has(err.kind);
      if (!moreAttemptsLeft || !kindIsRetryable) {
        throw err;
      }
      // Compute the raw exponential backoff, optionally cap it, then
      // optionally jitter. The reported `backoffMs` is the actually-slept
      // value so the trace event matches reality (not the abstract formula).
      //
      // That claim was FALSE until #122 and is now true by construction.
      // Measured on the pre-fix source:
      //
      //   backoffMs=1000:       onAttempt reported 1000 ms,       wall 1003 ms
      //   backoffMs=3600000000: onAttempt reported 3600000000 ms, wall    0 ms
      //
      // i.e. whenever Node's clamp fired, this reported the abstract formula and
      // slept 1 ms — and `onAttempt` is what the executor turns into
      // `retry_attempted` events, which `PgStore.writeRun` persists and the
      // trace UI renders. The trace claimed a 41.7-day backoff for something
      // that took under a millisecond. `validatePolicy` now makes an over-limit
      // sleep unconstructible, so no separate reporting fix is needed — the
      // number below and the real sleep agree because the clamp can't fire.
      let backoffMs = policy.backoffMs * multiplier ** (attempt - 1);
      if (policy.backoffMaxMs !== undefined && backoffMs > policy.backoffMaxMs) {
        backoffMs = policy.backoffMaxMs;
      }
      if ((policy.jitter ?? "none") === "full") {
        backoffMs = random() * backoffMs;
      }
      onAttempt({ attempt, backoffMs, error: err });
      await sleep(backoffMs);
    }
  }
  // Unreachable: the loop either returns on success or throws on the
  // final attempt; the `throw lastError` here just convinces TS the
  // function always exits with a value or an exception.
  throw lastError;
}
