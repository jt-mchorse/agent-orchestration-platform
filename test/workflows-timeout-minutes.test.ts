// Lock that every workflow job has a sensible `timeout-minutes` bound.
//
// Companion to `workflows-yaml-parseable.test.ts` (this repo's #41 /
// PR #35, propagated from portfolio-ops#30) — same silent-rot prevention
// arc, different failure mode. First TypeScript hop of the
// timeout-minutes lock that landed first as Python in
// `llm-eval-harness#63`, `rag-production-kit#55`,
// `chunking-strategies-lab#42`, and surfaced as a fingerprint in
// `portfolio-ops#36` (`audit_phase_a.py --check missing-timeout`).
//
// The failure mode this catches: GitHub Actions defaults to 360
// minutes (6 hours) per job when no `timeout-minutes` is set. A hung
// job — `npm ci` stalling on a registry, infinite typecheck loop,
// Playwright stuck waiting for the Next.js dev server — therefore
// burns the full 6-hour ceiling before the runner kills it. That's
// quota the operator pays for whether the run produced anything or not.
//
// Spec / origin: this repo's #43.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import yaml from "js-yaml";

const REPO_ROOT = resolve(__dirname, "..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github", "workflows");

// Policy band for this repo. Wide enough for `app` (npm ci + lint +
// typecheck + Vitest + Next.js build); tight enough that an accidental
// `timeout-minutes: 360` reverts most of the unbounded-job quota burn.
// Bumping the ceiling is intentional and should land with a comment
// naming the workload that forced the change.
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 30;

function listWorkflowFiles(): string[] {
  if (!existsSync(WORKFLOWS_DIR)) {
    return [];
  }
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => resolve(WORKFLOWS_DIR, name));
}

type JobRow = {
  workflow: string;
  jobId: string;
  body: Record<string, unknown>;
};

function listAllJobs(): JobRow[] {
  const rows: JobRow[] = [];
  for (const path of listWorkflowFiles()) {
    const parsed = yaml.load(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    > | null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const jobs = parsed.jobs;
    if (
      jobs === null ||
      typeof jobs !== "object" ||
      Array.isArray(jobs)
    ) {
      continue;
    }
    for (const [jobId, body] of Object.entries(
      jobs as Record<string, unknown>,
    )) {
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        rows.push({
          workflow: path.slice(WORKFLOWS_DIR.length + 1),
          jobId,
          body: body as Record<string, unknown>,
        });
      }
    }
  }
  return rows;
}

const ALL_JOBS = listAllJobs();

describe("workflow timeout-minutes lock (#36)", () => {
  // Smoke check: if this fails, the per-job tests below silently degrade
  // to a no-op. The fixture-discovery boundary is its own assertion.
  it("finds at least one workflow job", () => {
    expect(
      ALL_JOBS.length,
      `No jobs discovered under ${WORKFLOWS_DIR}. Either the workflow ` +
        "files were removed or YAML discovery is broken; this lock " +
        "should not silently pass in either case.",
    ).toBeGreaterThan(0);
  });

  for (const { workflow, jobId, body } of ALL_JOBS) {
    it(`${workflow}::${jobId} has a timeout-minutes`, () => {
      const timeout = body["timeout-minutes"];
      expect(
        timeout,
        `${workflow}::${jobId} has no \`timeout-minutes\` set. GitHub ` +
          "Actions defaults to 360 min/job when this is missing — a hung " +
          "job (npm ci stall, infinite typecheck loop, stuck Playwright " +
          "wait) burns the full 6-hour ceiling before the runner kills " +
          "it. Set `timeout-minutes:` on this job. For this repo's " +
          "workloads, 20 is the policy default for `app` and 15 for " +
          "lighter jobs; stay in " +
          `[${MIN_TIMEOUT_MINUTES}, ${MAX_TIMEOUT_MINUTES}].`,
      ).not.toBeUndefined();
    });

    it(`${workflow}::${jobId} timeout is an integer`, () => {
      const timeout = body["timeout-minutes"];
      if (timeout === undefined) {
        // Covered by the previous test.
        return;
      }
      const isInt =
        typeof timeout === "number" &&
        Number.isInteger(timeout) &&
        typeof timeout !== "boolean";
      expect(
        isInt,
        `${workflow}::${jobId} has \`timeout-minutes: ${JSON.stringify(
          timeout,
        )}\` (${typeof timeout}); GitHub Actions requires an integer. ` +
          "A YAML string like `'15'` is parsed but rejected at " +
          "workflow-load time, producing a silent failure shape similar " +
          "to the upstream yaml-parseable lock.",
      ).toBe(true);
    });

    it(`${workflow}::${jobId} timeout is in policy band`, () => {
      const timeout = body["timeout-minutes"];
      if (typeof timeout !== "number" || !Number.isInteger(timeout)) {
        // Covered by the previous test.
        return;
      }
      const inBand =
        timeout >= MIN_TIMEOUT_MINUTES && timeout <= MAX_TIMEOUT_MINUTES;
      expect(
        inBand,
        `${workflow}::${jobId} has \`timeout-minutes: ${timeout}\` ` +
          `outside the policy band [${MIN_TIMEOUT_MINUTES}, ` +
          `${MAX_TIMEOUT_MINUTES}]. Values above the ceiling ` +
          "reintroduce most of the unbounded-job quota burn; values at " +
          "0 disable the timeout entirely (GitHub Actions semantics). " +
          "If this job genuinely needs a wider bound (e.g., a future " +
          "future multi-agent eval suite), bump MAX_TIMEOUT_MINUTES with a " +
          "comment naming the workload that forced the change.",
      ).toBe(true);
    });
  }
});
