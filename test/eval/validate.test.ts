/**
 * Tests for `validateFixture`, `validateGolden`, and the
 * `npm run validate -- <path>` CLI (issue #39).
 *
 * First TypeScript port of the validate pattern shipped in four sister
 * repos this week (llm-eval-harness#56/#57, prompt-regression-suite
 * #49/#50, embedding-model-shootout#45/#46, chunking-strategies-lab
 * #37/#38). Coverage matrix:
 *
 * - Both committed fixtures + both committed goldens validate clean.
 * - Accumulating multi-finding case (does not fail fast).
 * - One positive case per finding code (parametrized via `it.each`).
 * - `wrong_schema_version` (the only enum-mismatch top-level case for fixtures).
 * - `repo_format` failure when `repo` is not `owner/name`.
 * - `files_empty` and `non_array_files`.
 * - `non_object_pr` and per-field pr.* missing / wrong-type.
 * - Golden recommendation enum mismatch + missing.
 * - Severity enum mismatch on a findings[i] entry.
 * - Reports are frozen (Object.isFrozen) and findings array is frozen.
 * - CLI end-to-end: clean exit 0, malformed exit 1 with per-finding
 *   stderr, --json shape, --golden flag, missing file exit 2, --help.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ValidationFinding,
  type ValidationReport,
  renderReportHuman,
  renderReportJson,
  validateFixture,
  validateGolden,
} from "../../src/eval/validate.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures", "sample-prs");
const SHIPPED_FIXTURES = [
  "rag-production-kit_pr9_hybrid_retrieval.json",
  "vector-search-at-scale_pr6_terraform_infra.json",
] as const;
const SHIPPED_GOLDENS = [
  "rag-production-kit_pr9_hybrid_retrieval.golden.json",
  "vector-search-at-scale_pr6_terraform_infra.golden.json",
] as const;

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = path.join(
    tmpdir(),
    `aop-validate-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeJson(name: string, value: unknown): Promise<string> {
  const p = path.join(tmpRoot, name);
  await writeFile(p, JSON.stringify(value), "utf-8");
  return p;
}

function validFixture(): Record<string, unknown> {
  return {
    schema_version: "1",
    source: "github",
    repo: "jt-mchorse/sample-repo",
    pr: {
      number: 1,
      title: "t",
      body: "b",
      state: "closed",
      merged: true,
      base: "main",
      head: "feat/x",
      additions: 1,
      deletions: 0,
      changed_files: 1,
      html_url: "https://example",
      created_at: "2026-01-01T00:00:00Z",
    },
    files: [
      {
        filename: "a.py",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@",
      },
    ],
  };
}

function validGolden(): Record<string, unknown> {
  return {
    schema_version: "1",
    fixture_id: "sample",
    golden_review: {
      summary: "ok",
      findings: [{ severity: "praise", message: "good" }],
      recommendation: "approve",
    },
  };
}

// ---------------------------------------------------------------------------
// Shipped fixtures + goldens
// ---------------------------------------------------------------------------

describe("validateFixture: shipped fixtures", () => {
  for (const name of SHIPPED_FIXTURES) {
    it(`validates ${name} cleanly`, async () => {
      const r = await validateFixture(path.join(FIXTURES_DIR, name));
      expect(r.ok, `unexpected findings: ${JSON.stringify(r.findings)}`).toBe(true);
      expect(r.findings).toEqual([]);
      expect(r.schemaVersion).toBe("1");
    });
  }
});

describe("validateGolden: shipped goldens", () => {
  for (const name of SHIPPED_GOLDENS) {
    it(`validates ${name} cleanly`, async () => {
      const r = await validateGolden(path.join(FIXTURES_DIR, name));
      expect(r.ok, `unexpected findings: ${JSON.stringify(r.findings)}`).toBe(true);
      expect(r.findings).toEqual([]);
      expect(r.recommendation).toMatch(/^(approve|approve_with_comments|request_changes)$/);
    });
  }
});

// ---------------------------------------------------------------------------
// validateFixture: schema findings
// ---------------------------------------------------------------------------

describe("validateFixture: schema findings", () => {
  it("collects multiple findings without failing fast", async () => {
    const broken = validFixture();
    delete (broken as Record<string, unknown>)["source"];
    (broken as Record<string, unknown>)["schema_version"] = "999";
    ((broken as Record<string, unknown>)["pr"] as Record<string, unknown>)["merged"] = "yes";
    const p = await writeJson("multi.json", broken);
    const r = await validateFixture(p);
    expect(r.ok).toBe(false);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("missing_source");
    expect(codes).toContain("wrong_schema_version");
    expect(codes).toContain("pr.merged_wrong_type");
  });

  it("flags malformed JSON without parsing further", async () => {
    const p = path.join(tmpRoot, "bad.json");
    await writeFile(p, "{not valid", "utf-8");
    const r = await validateFixture(p);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.code).toBe("malformed_json");
  });

  it("flags bare-string top-level as not_an_object", async () => {
    const p = await writeJson("bare.json", "not an object");
    const r = await validateFixture(p);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("not_an_object");
  });

  it("flags repo_format when repo is not owner/name", async () => {
    const v = validFixture();
    v["repo"] = "no-slash-here";
    const p = await writeJson("badrepo.json", v);
    const r = await validateFixture(p);
    expect(r.findings.map((f) => f.code)).toContain("repo_format");
  });

  it("flags files_empty when files is []", async () => {
    const v = validFixture();
    v["files"] = [];
    const p = await writeJson("empty.json", v);
    const r = await validateFixture(p);
    expect(r.findings.map((f) => f.code)).toContain("files_empty");
  });

  it("flags non_array_files when files is an object", async () => {
    const v = validFixture();
    v["files"] = { not: "an array" };
    const p = await writeJson("nonarr.json", v);
    const r = await validateFixture(p);
    expect(r.findings.map((f) => f.code)).toContain("non_array_files");
  });

  it("flags per-file status_wrong_value", async () => {
    const v = validFixture();
    (v["files"] as Array<Record<string, unknown>>)[0]!["status"] = "exploded";
    const p = await writeJson("badstatus.json", v);
    const r = await validateFixture(p);
    expect(r.findings.map((f) => f.code)).toContain("files[0].status_wrong_value");
  });

  it("accepts patch === null (binary/large)", async () => {
    const v = validFixture();
    (v["files"] as Array<Record<string, unknown>>)[0]!["patch"] = null;
    const p = await writeJson("nullpatch.json", v);
    const r = await validateFixture(p);
    expect(r.ok).toBe(true);
  });

  it("flags patch_wrong_type when patch is a number", async () => {
    const v = validFixture();
    (v["files"] as Array<Record<string, unknown>>)[0]!["patch"] = 42;
    const p = await writeJson("numpatch.json", v);
    const r = await validateFixture(p);
    expect(r.findings.map((f) => f.code)).toContain("files[0].patch_wrong_type");
  });

  it("flags pr non_object when pr is a string", async () => {
    const v = validFixture();
    v["pr"] = "should be an object";
    const p = await writeJson("strpr.json", v);
    const r = await validateFixture(p);
    expect(r.findings.map((f) => f.code)).toContain("non_object_pr");
  });

  it("flags pr.number_wrong_type when number is a float", async () => {
    const v = validFixture();
    (v["pr"] as Record<string, unknown>)["number"] = 3.14;
    const p = await writeJson("floatnum.json", v);
    const r = await validateFixture(p);
    expect(r.findings.map((f) => f.code)).toContain("pr.number_wrong_type");
  });
});

// ---------------------------------------------------------------------------
// validateGolden: schema findings
// ---------------------------------------------------------------------------

describe("validateGolden: schema findings", () => {
  it("flags missing_golden_review", async () => {
    const p = await writeJson("nogr.json", { schema_version: "1" });
    const r = await validateGolden(p);
    expect(r.findings.map((f) => f.code)).toContain("missing_golden_review");
  });

  it("flags recommendation_wrong_value", async () => {
    const v = validGolden();
    ((v["golden_review"] as Record<string, unknown>)["recommendation"] = "exploded");
    const p = await writeJson("badreco.json", v);
    const r = await validateGolden(p);
    expect(r.findings.map((f) => f.code)).toContain("recommendation_wrong_value");
  });

  it("flags findings_not_array when findings is an object", async () => {
    const v = validGolden();
    ((v["golden_review"] as Record<string, unknown>)["findings"] = { not: "array" });
    const p = await writeJson("badfindings.json", v);
    const r = await validateGolden(p);
    expect(r.findings.map((f) => f.code)).toContain("findings_not_array");
  });

  it("flags per-finding severity_wrong_value", async () => {
    const v = validGolden();
    const arr = ((v["golden_review"] as Record<string, unknown>)["findings"]) as Array<
      Record<string, unknown>
    >;
    arr[0]!["severity"] = "catastrophic";
    const p = await writeJson("badsev.json", v);
    const r = await validateGolden(p);
    expect(r.findings.map((f) => f.code)).toContain(
      "golden_review.findings[0].severity_wrong_value",
    );
  });

  it("collects multiple golden findings without failing fast", async () => {
    const v = validGolden();
    delete ((v["golden_review"] as Record<string, unknown>) as Record<string, unknown>)["summary"];
    ((v["golden_review"] as Record<string, unknown>)["recommendation"] = "exploded");
    const p = await writeJson("multi-golden.json", v);
    const r = await validateGolden(p);
    expect(r.ok).toBe(false);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("golden_review.summary_missing");
    expect(codes).toContain("recommendation_wrong_value");
  });
});

// ---------------------------------------------------------------------------
// Frozen shape
// ---------------------------------------------------------------------------

describe("ValidationReport shape", () => {
  it("is frozen and has a frozen findings array", async () => {
    const r = await validateFixture(path.join(FIXTURES_DIR, SHIPPED_FIXTURES[0]));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.findings)).toBe(true);
    expect(() => {
      (r as { ok: boolean }).ok = false;
    }).toThrow();
  });

  it("finding objects carry the three documented fields", async () => {
    const v = validFixture();
    delete (v as Record<string, unknown>)["source"];
    const p = await writeJson("missing-source.json", v);
    const r = await validateFixture(p);
    const f: ValidationFinding | undefined = r.findings[0];
    expect(f).toBeDefined();
    expect(Object.keys(f!).sort()).toEqual(["code", "jsonPath", "reason"]);
  });
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

describe("renderReportHuman + renderReportJson", () => {
  it("renderReportHuman writes per-finding stderr and an ok/fail stdout summary", async () => {
    const v = validFixture();
    delete (v as Record<string, unknown>)["source"];
    const p = await writeJson("missing-source.json", v);
    const r = await validateFixture(p);
    const out = renderReportHuman(r);
    expect(out.stdout.startsWith("fail:")).toBe(true);
    expect(out.stderr).toContain("[missing_source] at source");
    expect(out.stdout).toContain("findings=1");
  });

  it("renderReportJson round-trips through JSON.parse", async () => {
    const r = await validateFixture(path.join(FIXTURES_DIR, SHIPPED_FIXTURES[0]));
    const json = renderReportJson(r);
    const parsed = JSON.parse(json) as ValidationReport;
    expect(parsed.ok).toBe(r.ok);
    expect(parsed.findings.length).toBe(r.findings.length);
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------

interface CLIResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCLI(...args: string[]): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["tsx", path.join("src", "bin", "validate.ts"), ...args],
      { cwd: REPO_ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", reject);
  });
}

describe("CLI", () => {
  it(
    "exits 0 on a clean shipped fixture",
    async () => {
      const r = await runCLI(path.join(FIXTURES_DIR, SHIPPED_FIXTURES[0]));
      expect(r.code).toBe(0);
      expect(r.stdout.startsWith("ok:")).toBe(true);
    },
    20_000,
  );

  it(
    "exits 0 with --golden on a clean shipped golden",
    async () => {
      const r = await runCLI(path.join(FIXTURES_DIR, SHIPPED_GOLDENS[0]), "--golden");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("recommendation=");
    },
    20_000,
  );

  it(
    "exits 1 and writes per-finding stderr on a malformed fixture",
    async () => {
      const v = validFixture();
      delete (v as Record<string, unknown>)["source"];
      const p = await writeJson("malformed.json", v);
      const r = await runCLI(p);
      expect(r.code).toBe(1);
      expect(r.stdout.startsWith("fail:")).toBe(true);
      expect(r.stderr).toContain("missing_source");
    },
    20_000,
  );

  it(
    "exits 1 and emits a JSON report with --json",
    async () => {
      const v = validFixture();
      delete (v as Record<string, unknown>)["source"];
      const p = await writeJson("malformed-json-flag.json", v);
      const r = await runCLI(p, "--json");
      expect(r.code).toBe(1);
      const parsed = JSON.parse(r.stdout) as ValidationReport;
      expect(parsed.ok).toBe(false);
      expect(parsed.findings.length).toBeGreaterThan(0);
    },
    20_000,
  );

  it(
    "exits 2 on a missing file",
    async () => {
      const r = await runCLI(path.join(tmpRoot, "no-such.json"));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("file not found");
    },
    20_000,
  );
});
