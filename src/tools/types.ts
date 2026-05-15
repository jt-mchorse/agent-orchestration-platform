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
  | "unsupported_in_replay"
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
