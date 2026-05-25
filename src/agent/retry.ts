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
 * Run an async function with retry-on-`ToolError`.
 *
 * Semantics:
 * - On success, returns the value immediately.
 * - On a `ToolError` whose `kind` is in the policy's retryable set, calls
 *   `onAttempt` with the failure info, sleeps `backoffMs * mult^(n-1)`
 *   (clamped by `backoffMaxMs`, optionally jittered per `jitter`), and
 *   tries again. Up to `maxAttempts` total attempts.
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
