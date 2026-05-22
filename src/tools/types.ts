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
}
