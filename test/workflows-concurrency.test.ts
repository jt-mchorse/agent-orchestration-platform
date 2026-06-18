// Lock that every workflow file has a top-level `concurrency:` group.
//
// Companion to `workflows-yaml-parseable.test.ts` and
// `workflows-timeout-minutes.test.ts` — same silent-rot prevention
// arc, different failure mode. Propagation of the Python canonical
// first hop in `llm-eval-harness#64` and the audit-side fingerprint
// in `portfolio-ops#41` (`audit_phase_a.py --check missing-concurrency`).
//
// The failure mode this catches: without a `concurrency:` group, a
// rapid push-on-push (rebased session branch force-pushed, PR chain
// merged in quick succession, contributor amending mid-flight) burns
// one full CI run per push even though the in-flight run is
// immediately superseded. For this repo's `app` job (npm ci + lint +
// typecheck + vitest + Next.js build) that's meaningful operator
// savings during back-and-forth review iterations.
//
// Spec / origin: this repo's #45. Propagated from nextjs-streaming-ai-patterns #38 (first TS hop) and llm-eval-harness #64 (Python canonical first hop).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import yaml from "js-yaml";

const REPO_ROOT = resolve(__dirname, "..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github", "workflows");

function listWorkflowFiles(): string[] {
  if (!existsSync(WORKFLOWS_DIR)) {
    return [];
  }
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => resolve(WORKFLOWS_DIR, name));
}

type WorkflowRow = {
  workflow: string;
  parsed: Record<string, unknown>;
};

function listAllWorkflows(): WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  for (const path of listWorkflowFiles()) {
    const parsed = yaml.load(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    > | null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    rows.push({
      workflow: path.slice(WORKFLOWS_DIR.length + 1),
      parsed: parsed as Record<string, unknown>,
    });
  }
  return rows;
}

const ALL_WORKFLOWS = listAllWorkflows();

describe("workflow concurrency lock (#45)", () => {
  // Smoke check: if this fails, the per-workflow tests below silently
  // degrade to a no-op. The fixture-discovery boundary is its own
  // assertion — a moved or deleted workflows dir should fail the lock,
  // not silently pass it.
  it("finds at least one workflow file", () => {
    expect(
      ALL_WORKFLOWS.length,
      `No workflow files discovered under ${WORKFLOWS_DIR}. Either the ` +
        "workflow files were removed or YAML discovery is broken; this " +
        "lock should not silently pass in either case.",
    ).toBeGreaterThan(0);
  });

  for (const { workflow, parsed } of ALL_WORKFLOWS) {
    it(`${workflow} has a top-level concurrency block`, () => {
      const concurrency = parsed.concurrency;
      expect(
        concurrency,
        `${workflow} has no top-level \`concurrency:\` block. Without ` +
          "one, a rapid push-on-push burns one full CI run per push even " +
          "when the in-flight run is immediately superseded. Add " +
          "`concurrency: { group: '<workflow>-${{ github.ref }}', " +
          "cancel-in-progress: true }` at the top level.",
      ).not.toBeUndefined();
    });

    it(`${workflow} concurrency.group is a non-empty string`, () => {
      const concurrency = parsed.concurrency;
      if (
        concurrency === null ||
        typeof concurrency !== "object" ||
        Array.isArray(concurrency)
      ) {
        // Covered by the previous test.
        return;
      }
      const group = (concurrency as Record<string, unknown>).group;
      const isNonEmptyStr = typeof group === "string" && group.trim().length > 0;
      expect(
        isNonEmptyStr,
        `${workflow} has \`concurrency.group: ${JSON.stringify(group)}\` ` +
          `(${typeof group}); must be a non-empty string. GitHub ` +
          "Actions evaluates the group at runtime; an empty or missing " +
          "group falls back to a default that doesn't dedupe — silently " +
          "reintroducing the failure mode this lock exists to prevent.",
      ).toBe(true);
    });

    it(`${workflow} concurrency.cancel-in-progress is true`, () => {
      const concurrency = parsed.concurrency;
      if (
        concurrency === null ||
        typeof concurrency !== "object" ||
        Array.isArray(concurrency)
      ) {
        // Covered by the previous test.
        return;
      }
      const cancel = (concurrency as Record<string, unknown>)[
        "cancel-in-progress"
      ];
      const isTrueBool = typeof cancel === "boolean" && cancel === true;
      expect(
        isTrueBool,
        `${workflow} has \`concurrency.cancel-in-progress: ` +
          `${JSON.stringify(cancel)}\` (${typeof cancel}); must be the ` +
          "YAML bool `true`. A string `'true'` is parsed but produces " +
          "the inverse semantics under some GitHub Actions paths " +
          "(queue rather than cancel), and `false` defeats the lock's " +
          "purpose — the prior run would complete, burning the quota " +
          "the lock exists to save.",
      ).toBe(true);
    });
  }
});
