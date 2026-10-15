/**
 * A lone surrogate in a fixture-key input is `input_validation`, not an
 * aborted run (#213).
 *
 * #201 made `read_file_at_ref`'s cache file name `encodeURIComponent` of each
 * input component, and `encodeURIComponent` throws `URIError` on a lone
 * surrogate. The schema accepted one, so the tool threw a plain `URIError`,
 * which the executor re-raises as a programmer bug: the run aborted after
 * `step_started` with no observation, replan or review. #207 gives `run_check`
 * the same key, so both tools are pinned here. Inputs are built from code
 * points so no literal surrogate sits in the source.
 */
import { describe, expect, it } from "vitest";

import { AgentRun } from "../../src/agent/executor.js";
import { ScriptedPlanner } from "../../src/agent/planner.js";
import { Trace } from "../../src/agent/trace.js";
import { readFileAtRefTool } from "../../src/tools/read-file-at-ref.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runCheckTool } from "../../src/tools/run-check.js";
import { ToolError, type ToolContext } from "../../src/tools/types.js";

const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);
// U+1F600 as a well-formed pair: one astral code point, a legal name.
const ASTRAL = String.fromCharCode(0xd83d, 0xde00);

const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileAtRefTool);
  r.register(runCheckTool);
  return r;
}

const READ_BASE = { owner: "jt-mchorse", repo: "demo", ref: "feature/x", path: "src/a.py" };
const CHECK_BASE = { owner: "jt-mchorse", repo: "demo", ref: "feature/x" };

const CASES: Array<[string, Record<string, string>, string]> = [];
for (const [tool, base] of [
  ["read_file_at_ref", READ_BASE],
  ["run_check", CHECK_BASE],
] as const) {
  for (const field of Object.keys(base)) {
    for (const [label, half] of [
      ["high", HIGH],
      ["low", LOW],
    ] as const) {
      CASES.push([tool, { ...base, [field]: `x${half}y` }, `${field} with a lone ${label} surrogate`]);
    }
  }
}

describe("fixture-key inputs refuse a lone surrogate (#213)", () => {
  it.each(CASES)("%s: %j is input_validation (%s)", async (tool, input) => {
    const err = await registry()
      .invoke(tool, input, ctx)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe("input_validation");
  });

  it("still accepts a well-formed astral pair", async () => {
    const out = (await registry().invoke(
      "run_check",
      { ...CHECK_BASE, ref: `feature/${ASTRAL}` },
      ctx,
    )) as { source: string };
    expect(out.source).toBe("missing_fixture");
    // read_file_at_ref reaches its lookup and misses, rather than refusing.
    const err = await registry()
      .invoke("read_file_at_ref", { ...READ_BASE, ref: `feature/${ASTRAL}` }, ctx)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as ToolError).kind).toBe("not_found");
  });
});

describe("a lone surrogate in a planned step no longer aborts the run (#213)", () => {
  it.each([
    ["read_file_at_ref", { ...READ_BASE, ref: `feature${HIGH}` }],
    ["run_check", { ...CHECK_BASE, ref: `feature${HIGH}` }],
  ])("%s: the step is an observation and the run finalizes", async (tool, input) => {
    const planner = new ScriptedPlanner({
      goal: "one step",
      steps: [{ rationale: "planner-supplied input", tool, input }],
    });
    const trace = new Trace();
    const review = await new AgentRun(registry(), planner, trace, ctx).run({
      owner: "jt-mchorse",
      repo: "demo",
      number: 1,
    });
    expect(review).toBeDefined();
    const kinds = trace.events().map((e) => e.kind);
    expect(kinds).toContain("observation");
    expect(kinds.at(-1)).toBe("finalized");
  });
});
