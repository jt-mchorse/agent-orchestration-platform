// Lock that every workflow YAML in this repo parses cleanly.
//
// TypeScript sibling of `portfolio-ops/tests/test_workflows_yaml_parseable.py`
// (portfolio-ops#30 / portfolio-ops#31), modelled after the Python ports
// shipped to llm-eval-harness#61, rag-production-kit#53, and
// chunking-strategies-lab#40.
//
// The original lock was written because PR portfolio-ops#27 /
// portfolio-ops#28 closed a 21-day silent CI outage caused by a single
// unquoted colon-space in a `run:` value:
//
//     - name: Verify D-001 baseline decision exists
//       run: grep -q "id: D-001" MEMORY/core_decisions_ai.md
//
// `yaml.load()` would reject the line with `YAMLException: mapping
// values are not allowed here`. GitHub Actions' parser is lenient
// enough to *complete* the workflow run with zero jobs and
// `conclusion=failure`; `statusCheckRollup` stays empty so Phase A
// auto-merge can't tell that no CI ran.
//
// `agent-orchestration-platform`'s workflows use the `run: |` block-
// scalar form today and are YAML-safe, so this lock is the inverse
// safety net: it makes the unparseable-shape failure *cannot* land here
// either. A `jobs:` non-empty assertion catches the broader "valid
// YAML, no actual workflow" failure mode in case GitHub Actions
// silently absorbs another shape the same way.
//
// Related: portfolio-ops#27, portfolio-ops#28, portfolio-ops#30,
// llm-eval-harness#60, this repo's #41.

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

const WORKFLOW_FILES = listWorkflowFiles();
const SILENT_CI_HINT =
  "GitHub Actions' parser is lenient enough to *complete* a workflow " +
  "with an unparseable file, emitting zero jobs and `conclusion=failure` " +
  "with an empty `statusCheckRollup` — the exact silent-CI shape that " +
  "blocked portfolio-ops for 21 days (#27). Fix the YAML, do not skip this lock.";

describe("workflows YAML parseability lock (#41)", () => {
  // Smoke check: if this fails, the per-file tests below silently degrade
  // to a no-op. The fixture-discovery boundary is its own assertion.
  it("finds at least one workflow file", () => {
    expect(
      WORKFLOW_FILES.length,
      `No *.yml files found under ${WORKFLOWS_DIR}. ` +
        "If the workflows were intentionally removed, delete this lock test.",
    ).toBeGreaterThan(0);
  });

  for (const path of WORKFLOW_FILES) {
    const rel = path.slice(REPO_ROOT.length + 1);

    it(`${rel} parses cleanly with yaml.load`, () => {
      const text = readFileSync(path, "utf-8");
      let parsed: unknown;
      try {
        parsed = yaml.load(text);
      } catch (exc) {
        throw new Error(
          `${rel} failed yaml.load:\n${String(exc)}\n${SILENT_CI_HINT}`,
        );
      }
      // A workflow file should be a YAML mapping with at least `name`,
      // `on`, and `jobs` keys.
      expect(
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
        `${rel} parsed to ${
          parsed === null ? "null" : typeof parsed
        }, expected a top-level mapping.`,
      ).toBe(true);
    });

    it(`${rel} has a non-empty jobs: mapping`, () => {
      const parsed = yaml.load(readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
      const jobs = parsed.jobs;
      // A workflow with no jobs is the broader shape of the phantom-failure
      // bug — valid YAML, but GitHub Actions still emits a completed/failure
      // run with zero work. If a file is intentionally a reusable workflow
      // with only `on:` and a callable surface, exempt it explicitly here.
      expect(
        jobs !== null && typeof jobs === "object" && !Array.isArray(jobs),
        `${rel}: expected jobs to be a mapping, got ${typeof jobs}.`,
      ).toBe(true);
      expect(
        Object.keys(jobs as Record<string, unknown>).length,
        `${rel}: jobs mapping is empty.`,
      ).toBeGreaterThan(0);
    });
  }
});
