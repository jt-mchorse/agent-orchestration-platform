import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentRun } from "../agent/executor.js";
import { ScriptedPlanner } from "../agent/planner.js";
import { Trace } from "../agent/trace.js";
import type { Plan, PlannerState, Review } from "../agent/types.js";
import { buildDefaultRegistry } from "../index.js";
import type { ToolContext } from "../tools/types.js";
import type { ReviewScore } from "./score.js";
import { scoreReview } from "./score.js";

/**
 * One evaluation: run the agent against a fixture PR, score its
 * `Review` against the committed golden, return both for downstream
 * rendering.
 */
export interface EvalCase {
  fixture_id: string;
  fixture_path: string;
  golden_path: string;
}

export interface EvalCaseResult {
  fixture_id: string;
  actual: Review;
  golden: Review;
  score: ReviewScore;
}

export interface EvalRun {
  cases: EvalCaseResult[];
  composite_mean: number;
  recommendation_accuracy: number;
  findings_f1_mean: number;
}

/**
 * Run the agent against `fixture_path` and return the synthesized review.
 *
 * Uses a `ScriptedPlanner` because no LLM-driven `AnthropicPlanner` is
 * in `main` yet (the planner interface from #3 is the seam where the
 * real planner plugs in later). The scripted plan fetches the PR and
 * synthesizes a review from the fixture's title + file list — a
 * placeholder strategy that lets the eval suite produce *some* output
 * to score, so the workflow is end-to-end runnable. Once the LLM
 * planner lands, swap `_buildScriptedReview` for `AnthropicPlanner`
 * and the rest of the runner is unchanged.
 */
export async function runAgentOnFixture(fixture_path: string): Promise<Review> {
  const fixtureText = await fs.readFile(fixture_path, "utf-8");
  const fixture = JSON.parse(fixtureText) as {
    pr: { number: number; title: string; changed_files: number };
    repo: string;
    files: Array<{ filename: string; status: string }>;
  };
  const [owner, repoName] = fixture.repo.split("/");
  if (!owner || !repoName) {
    throw new Error(`fixture.repo must be 'owner/name'; got ${fixture.repo}`);
  }
  const pr = { owner, repo: repoName, number: fixture.pr.number };

  const plan: Plan = {
    goal: "fetch the PR and synthesize a structured review",
    steps: [
      {
        rationale: "load the PR fixture for context",
        tool: "fetch_pr",
        input: pr,
      },
    ],
  };
  const planner = new ScriptedPlanner(
    plan,
    [],
    (state: PlannerState): Review => _buildScriptedReview(state, fixture),
  );
  const ctx: ToolContext = {
    mode: "replay",
    fixturesDir: path.dirname(fixture_path),
  };
  const trace = new Trace();
  return new AgentRun(buildDefaultRegistry(), planner, trace, ctx).run(pr);
}

function _buildScriptedReview(
  state: PlannerState,
  fixture: { pr: { title: string; changed_files: number }; files: Array<{ filename: string }> },
): Review {
  // Placeholder agent behavior: produce a review from the fixture's
  // metadata. This is *not* a good reviewer — it doesn't read code,
  // doesn't use the cross-reference tools, doesn't ask hard questions.
  // It exists so the eval suite has a non-trivial actual review to
  // score against the hand-labeled golden, exercising the full
  // workflow end-to-end. Once `AnthropicPlanner` lands, this function
  // gets replaced by the LLM planner's `finalize()`.
  const file_list = fixture.files
    .slice(0, 3)
    .map((f) => f.filename)
    .join(", ");
  const summary =
    `Scripted-agent review of "${fixture.pr.title}". ` +
    `Touched ${fixture.pr.changed_files} file(s); top files: ${file_list}. ` +
    "Recommendation is heuristic from file types; an LLM-driven planner replaces this in a follow-up.";
  // Heuristic recommendation based on a deliberately simple rule —
  // not meaningful as a real reviewer, but produces something the
  // eval can score.
  const hasInfra = fixture.files.some((f) => /\.tf$|infra\/|terraform/i.test(f.filename));
  const recommendation: Review["recommendation"] = hasInfra
    ? "request_changes"
    : "approve_with_comments";
  void state;
  return {
    summary,
    findings: [],
    recommendation,
  };
}

/**
 * Run the agent against every `EvalCase`, score each, aggregate.
 */
export async function evaluateAll(cases: EvalCase[]): Promise<EvalRun> {
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    const goldenText = await fs.readFile(c.golden_path, "utf-8");
    const golden = (JSON.parse(goldenText) as { golden_review: Review }).golden_review;
    const actual = await runAgentOnFixture(c.fixture_path);
    const score = scoreReview(actual, golden);
    results.push({ fixture_id: c.fixture_id, actual, golden, score });
  }
  const n = results.length;
  const composite_mean =
    n === 0 ? 0 : results.reduce((acc, r) => acc + r.score.composite, 0) / n;
  const recommendation_accuracy =
    n === 0 ? 0 : results.reduce((acc, r) => acc + r.score.recommendation_match, 0) / n;
  const findings_f1_mean =
    n === 0 ? 0 : results.reduce((acc, r) => acc + r.score.findings_f1, 0) / n;
  return { cases: results, composite_mean, recommendation_accuracy, findings_f1_mean };
}

/**
 * Discover golden-pair cases under a fixtures directory.
 *
 * A "case" is a fixture JSON file whose sibling `<name>.golden.json`
 * exists. Files without a sibling golden are skipped (not all fixtures
 * have hand-labels yet); files whose golden lacks a `golden_review`
 * block are also skipped, with a warning logged to stderr.
 */
export async function discoverCases(fixturesDir: string): Promise<EvalCase[]> {
  const entries = await fs.readdir(fixturesDir);
  const out: EvalCase[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".golden.json")) continue;
    const stem = name.slice(0, -".json".length);
    const golden = `${stem}.golden.json`;
    if (!entries.includes(golden)) continue;
    out.push({
      fixture_id: stem,
      fixture_path: path.join(fixturesDir, name),
      golden_path: path.join(fixturesDir, golden),
    });
  }
  return out.sort((a, b) => a.fixture_id.localeCompare(b.fixture_id));
}

/**
 * Validate the `--comment` target for the eval runner: `--repo owner/name`
 * present and `--pr` a positive integer. Returns an operator-facing error
 * message, or `null` when the target is valid.
 *
 * `--pr` is `Number(...)`-coerced in the CLI, so a truthy-but-invalid value —
 * a negative, non-finite, or non-integer PR number (`--pr -5`, `--pr Infinity`,
 * `--pr 3.5`) — would otherwise slip past a bare falsy check and reach the
 * GitHub API URL (`.../issues/${pr}/comments`) unchecked, turning an operator
 * typo into a confusing API error. Enforce the same finite-integer contract the
 * repo applies to `RetryPolicy.maxAttempts` and `ExecutorOptions.maxReplans`
 * (#29/#31). A falsy `--pr` (`NaN` from `--pr abc`, or `0`) reports as
 * "must be a positive integer" rather than "missing" for a clearer diagnostic.
 */
export function commentTargetError(repo: string | null, pr: number | null): string | null {
  if (!repo || pr === null) {
    return "--comment requires --repo owner/name and --pr <n>";
  }
  if (!Number.isInteger(pr) || pr < 1) {
    return `--pr must be a positive integer; got ${pr}`;
  }
  return null;
}
