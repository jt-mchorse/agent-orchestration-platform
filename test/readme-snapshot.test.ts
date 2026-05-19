import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { renderEvalMarkdown } from "../src/eval/comment.js";
import { discoverCases, evaluateAll, type EvalRun } from "../src/eval/runner.js";

const ROOT = resolve(__dirname, "..");
const README_PATH = resolve(ROOT, "README.md");
const SNAPSHOT_PATH = resolve(ROOT, "docs/eval_snapshot.md");
const FIXTURES_DIR = resolve(ROOT, "fixtures/sample-prs");
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");
const REGEN_HINT =
  "Regenerate with `npx tsx scripts/render-eval-snapshot.ts` and re-inspect `git diff docs/eval_snapshot.md` before committing.";

describe("docs/eval_snapshot.md is locked to the live renderer", () => {
  let run: EvalRun;
  let rendered: string;

  beforeAll(async () => {
    const cases = await discoverCases(FIXTURES_DIR);
    run = await evaluateAll(cases);
    rendered = renderEvalMarkdown(run);
  });

  it("committed snapshot matches renderEvalMarkdown(evaluateAll(discoverCases(...)))", () => {
    const committed = readFileSync(SNAPSHOT_PATH, "utf-8");
    expect(rendered, REGEN_HINT).toBe(committed);
  });

  it("renderer produces the expected two fixtures", () => {
    expect(run.cases.length).toBe(2);
    const ids = run.cases.map((c) => c.fixture_id).sort();
    expect(ids).toEqual([
      "rag-production-kit_pr9_hybrid_retrieval",
      "vector-search-at-scale_pr6_terraform_infra",
    ]);
  });
});

describe("README Benchmarks table matches docs/eval_snapshot.md numbers", () => {
  const readme = readFileSync(README_PATH, "utf-8");
  let run: EvalRun;

  beforeAll(async () => {
    const cases = await discoverCases(FIXTURES_DIR);
    run = await evaluateAll(cases);
  });

  function find3Decimals(label: string): number {
    const re = new RegExp(`\\| ${label} \\| \\*\\*([0-9.]+)\\*\\* \\|`);
    const m = readme.match(re);
    expect(m, `README missing metric row for "${label}"`).not.toBeNull();
    return Number(m![1]);
  }

  it("composite mean row matches", () => {
    expect(find3Decimals("composite mean")).toBeCloseTo(run.composite_mean, 3);
  });

  it("findings F1 mean row matches", () => {
    expect(find3Decimals("findings F1 mean")).toBeCloseTo(run.findings_f1_mean, 3);
  });

  it("recommendation accuracy row matches", () => {
    const re =
      /\| recommendation accuracy \| \*\*([0-9]+)%\*\* \(([0-9]+) \/ ([0-9]+)\) \|/;
    const m = readme.match(re);
    expect(m, "README missing recommendation accuracy row").not.toBeNull();
    const pct = Number(m![1]);
    const hits = Number(m![2]);
    const total = Number(m![3]);
    expect(pct / 100).toBeCloseTo(run.recommendation_accuracy, 2);
    expect(total).toBe(run.cases.length);
    expect(hits).toBe(run.cases.filter((c) => c.score.recommendation_match === 1).length);
  });

  it("per-fixture rows match each case's composite within 3 decimals", () => {
    for (const c of run.cases) {
      const escaped = c.fixture_id.replace(/[-/]/g, "\\$&");
      const re = new RegExp(
        `\\| \`${escaped}\` \\| (✓|✗) \\| ([0-9.]+) \\| ([0-9.]+) \\|`,
      );
      const m = readme.match(re);
      expect(m, `README missing per-fixture row for ${c.fixture_id}. ${REGEN_HINT}`).not.toBeNull();
      const check = m![1];
      const f1 = Number(m![2]);
      const composite = Number(m![3]);
      const expectedMark = c.score.recommendation_match === 1 ? "✓" : "✗";
      expect(check).toBe(expectedMark);
      expect(f1).toBeCloseTo(c.score.findings_f1, 3);
      expect(composite).toBeCloseTo(c.score.composite, 3);
    }
  });
});

describe("README Quickstart npm commands all exist in package.json", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  const readme = readFileSync(README_PATH, "utf-8");

  // Match `npm run <name>` and `npm <verb>` shapes used in the Quickstart block.
  const NPM_RUN_RE = /npm run ([\w:-]+)/g;
  const BUILTIN_VERBS = new Set(["test", "install", "ci"]);

  it("every `npm run <name>` referenced in the README is a real script", () => {
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));
    const referenced = new Set<string>();
    for (const m of readme.matchAll(NPM_RUN_RE)) {
      const name = m[1];
      if (name) referenced.add(name);
    }
    expect(referenced.size, "no `npm run …` invocations found in README").toBeGreaterThan(0);
    for (const name of referenced) {
      expect(scripts.has(name), `README references \`npm run ${name}\` but package.json has no such script`).toBe(true);
    }
  });

  it("every bare `npm <verb>` form maps to a builtin or a script", () => {
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));
    const NPM_BARE_RE = /(?<!\w)npm ([a-z][\w:-]*)(?:[^a-zA-Z]|$)/g;
    for (const m of readme.matchAll(NPM_BARE_RE)) {
      const verb = m[1] ?? "";
      if (!verb || verb === "run") continue;
      const ok = BUILTIN_VERBS.has(verb) || scripts.has(verb);
      expect(ok, `README references \`npm ${verb}\` but it is neither a builtin nor a defined script`).toBe(true);
    }
  });
});

describe("README references real files on disk", () => {
  const readme = readFileSync(README_PATH, "utf-8");

  it("docs/eval_snapshot.md exists", () => {
    expect(existsSync(SNAPSHOT_PATH)).toBe(true);
  });

  it("scripts/render-eval-snapshot.ts exists", () => {
    expect(existsSync(resolve(ROOT, "scripts/render-eval-snapshot.ts"))).toBe(true);
  });

  it("test/readme-snapshot.test.ts is referenced by the README", () => {
    expect(readme).toMatch(/test\/readme-snapshot\.test\.ts/);
  });
});
