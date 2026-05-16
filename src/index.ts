export { ToolRegistry } from "./tools/registry.js";
export {
  ToolError,
  type Tool,
  type ToolContext,
  type ToolMode,
  type AnyTool,
  type ToolAnnotations,
  type ToolErrorKind,
  type ApprovalRequest,
  type ApprovalDecision,
  type ApprovalProvider,
} from "./tools/types.js";
export { fetchPrTool } from "./tools/fetch-pr.js";
export { readFileAtRefTool } from "./tools/read-file-at-ref.js";
export { searchRepoTool } from "./tools/search-repo.js";
export { runCheckTool } from "./tools/run-check.js";
export {
  getPortfolioContextTool,
  createGetPortfolioContextTool,
  type GetPortfolioContextConnect,
} from "./tools/get-portfolio-context.js";
export { postReviewCommentTool } from "./tools/post-review-comment.js";
export {
  createCliApprovalProvider,
  autoApproveProvider,
  denyAllProvider,
  type CliApprovalOptions,
} from "./agent/cli-approval.js";
export {
  type Finding,
  type FindingSeverity,
  type Observation,
  type Plan,
  type PlannedStep,
  type PlannerState,
  type ReplanReason,
  type Review,
} from "./agent/types.js";
export { type Planner, ScriptedPlanner } from "./agent/planner.js";
export { Trace, type TraceEvent, type Clock } from "./agent/trace.js";
export {
  AgentRun,
  DEFAULT_MAX_REPLANS,
  type ExecutorOptions,
} from "./agent/executor.js";
export {
  aggregateCost,
  MemoryStore,
  type AggregatedCost,
  type RunDetail,
  type RunSummary,
  type TraceStore,
  type WriteRunInput,
} from "./trace/store.js";
export { PgStore, type PgStoreOptions } from "./trace/pg-store.js";
export { createTraceServer, type TraceServerOptions } from "./ui/server.js";
export type { StepCost } from "./agent/types.js";
export {
  STICKY_MARKER as EVAL_STICKY_MARKER,
  findStickyCommentId,
  renderEvalMarkdown,
  upsertStickyComment,
  type UpsertOptions,
} from "./eval/comment.js";
export {
  discoverCases,
  evaluateAll,
  runAgentOnFixture,
  type EvalCase,
  type EvalCaseResult,
  type EvalRun,
} from "./eval/runner.js";
export { scoreReview, matchFindings, jaccard, type ReviewScore } from "./eval/score.js";

import { ToolRegistry } from "./tools/registry.js";
import { fetchPrTool } from "./tools/fetch-pr.js";
import { readFileAtRefTool } from "./tools/read-file-at-ref.js";
import { searchRepoTool } from "./tools/search-repo.js";
import { runCheckTool } from "./tools/run-check.js";
import { getPortfolioContextTool } from "./tools/get-portfolio-context.js";
import { postReviewCommentTool } from "./tools/post-review-comment.js";

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fetchPrTool);
  registry.register(readFileAtRefTool);
  registry.register(searchRepoTool);
  registry.register(runCheckTool);
  registry.register(getPortfolioContextTool);
  registry.register(postReviewCommentTool);
  return registry;
}
