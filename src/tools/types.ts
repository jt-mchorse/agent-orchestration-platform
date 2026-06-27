import type { ZodTypeAny, z } from "zod";

export type ToolMode = "replay" | "live";

export interface ApprovalRequest {
  toolName: string;
  input: unknown;
  reason: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ApprovalProvider {
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface ToolContext {
  mode: ToolMode;
  fixturesDir: string;
  approvals?: ApprovalProvider;
}

export interface ToolAnnotations {
  /**
   * Marks the tool as having an externally-visible destructive effect (e.g.
   * posts to GitHub, sends email, executes a write against shared state).
   * The registry blocks invocation of destructive tools unless the
   * ToolContext's approval provider returns `approved: true`.
   */
  destructive?: boolean;
  /**
   * Human-readable phrase the approval prompt uses to describe the
   * destructive effect (e.g. "post a public review comment on the PR").
   * Required when destructive is true.
   */
  destructiveReason?: string;
  /**
   * Optional retry policy applied by `AgentRun` when this tool throws a
   * `ToolError` whose kind is in `retryableErrorKinds`. The default is no
   * retry (one attempt); the policy is opt-in per tool because retrying is
   * almost always wrong for input/output validation failures and almost
   * always right for transient network/internal errors. Configured here
   * rather than as an executor-side side-table so `registry.list()` stays
   * self-describing and policy can't silently drift from tool changes
   * (D-012).
   */
  retry?: RetryPolicy;
  /**
   * Optional name of an alternative tool to try once this tool's retries
   * are exhausted. The fallback tool must be registered in the same
   * `ToolRegistry` and its `inputSchema` must accept the same input the
   * planner provided to the primary. Only one level of fallback is
   * supported — if the fallback also fails, the executor proceeds to the
   * planner-replan path. Cycle-by-construction is impossible because the
   * fallback's own `fallbackTo` is *not* followed.
   */
  fallbackTo?: string;
}

/**
 * Retry policy for a single tool invocation.
 *
 * Backoff schedule for attempt N (1-indexed) is
 * `backoffMs * backoffMultiplier^(N-1)`. After the last attempt the
 * error is surfaced unchanged. Only `ToolError`s whose `kind` is in
 * `retryableErrorKinds` are retried; everything else short-circuits.
 */
export interface RetryPolicy {
  /** Total attempts, including the first. Clamped to `>= 1` at runtime. */
  maxAttempts: number;
  /** Initial backoff. Subsequent attempts multiply by `backoffMultiplier`. */
  backoffMs: number;
  /** Default 2.0 (binary exponential). 1.0 = fixed-interval retry. */
  backoffMultiplier?: number;
  /**
   * Optional upper bound on the per-attempt sleep. When set, the computed
   * `backoffMs * backoffMultiplier^(n-1)` is clamped to `backoffMaxMs`
   * before any jitter is applied. Undefined keeps the existing unbounded
   * exponential schedule. Recommended for any policy with
   * `maxAttempts > 5` to avoid runaway sleep growth.
   */
  backoffMaxMs?: number;
  /**
   * Optional jitter strategy applied to the (capped) backoff before sleeping.
   * - `"none"` (default): sleep exactly the computed value (current behavior).
   * - `"full"`: sleep a uniform random in `[0, computed]`. Disperses concurrent
   *   retries so the same downstream service isn't hit by a synchronized
   *   thundering herd. Per Google SRE book and AWS SDK guidance.
   */
  jitter?: "none" | "full";
  /**
   * Which `ToolError` kinds are retryable. Default is `["internal"]` —
   * transient runtime failures only. Validation kinds and approval kinds
   * are never sensible to retry without changing the inputs.
   */
  retryableErrorKinds?: ToolErrorKind[];
}

export interface Tool<InputSchema extends ZodTypeAny, OutputSchema extends ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  annotations?: ToolAnnotations;
  run: (input: z.infer<InputSchema>, ctx: ToolContext) => Promise<z.infer<OutputSchema>>;
}

export type AnyTool = Tool<ZodTypeAny, ZodTypeAny>;

export type ToolErrorKind =
  | "input_validation"
  | "output_validation"
  | "not_found"
  | "unsupported_in_live"
  | "approval_denied"
  | "approval_missing"
  | "internal";

export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  readonly toolName: string;
  constructor(toolName: string, kind: ToolErrorKind, message: string) {
    super(`[${toolName}:${kind}] ${message}`);
    this.kind = kind;
    this.toolName = toolName;
    this.name = "ToolError";
  }

  // `Error` sets `message` as a non-enumerable own property, so JSON.stringify
  // drops it — which silently lost the failure message from every ToolError
  // persisted to the Postgres trace store (PgStore.writeRun → JSON.stringify),
  // leaving the run-detail UI to render "error: <kind> — undefined" (#65).
  // JSON.stringify honors toJSON(), so make the serialized shape explicit and
  // message-preserving; it's applied recursively, so a nested `reason.error`
  // in a re_plan_triggered event is covered too.
  toJSON(): { name: string; kind: ToolErrorKind; toolName: string; message: string } {
    return { name: this.name, kind: this.kind, toolName: this.toolName, message: this.message };
  }
}
