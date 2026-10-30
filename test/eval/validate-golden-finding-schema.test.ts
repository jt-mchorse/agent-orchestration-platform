/**
 * `validateGolden` checks each golden finding with `post_review_comment`'s own
 * finding schema (#294).
 *
 * It checked only `severity` and `message`. Since #293 the tool validates the
 * canonical `Finding` strictly, so a golden with `"file": 5`, `"lineRange":
 * "x"`, a reversed range, an empty `file` or the legacy `line_start` key
 * validated clean (`ok ... findings=0`, rc 0 on origin/main 711eae9) and was
 * only refused when the Review was posted.
 *
 * Differential, so a later narrowing of the tool's schema shows up here
 * without anyone listing it: every mutant the validator accepts must parse
 * under `findingSchema`, and every mutant the schema refuses must be flagged.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateGolden } from "../../src/eval/validate.js";
import { findingSchema } from "../../src/tools/post-review-comment.js";

const FIXTURES = path.join(__dirname, "..", "..", "fixtures", "sample-prs");

let dir: string;
let golden: { golden_review: { findings: Record<string, unknown>[] } };

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aop-golden-finding-"));
  const name = (await readdir(FIXTURES)).filter((n) => n.endsWith(".golden.json")).sort()[0]!;
  golden = JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function validateWithFinding(finding: Record<string, unknown>) {
  const copy = JSON.parse(JSON.stringify(golden)) as typeof golden;
  copy.golden_review.findings[0] = finding;
  const p = path.join(dir, `g${n++}.golden.json`);
  await writeFile(p, JSON.stringify(copy));
  return validateGolden(p);
}

const BASE = { severity: "concern", message: "m", file: "src/a.py", lineRange: [3, 4] };

// [name, finding, jsonPath the validator must name]
const REFUSED: [string, Record<string, unknown>, string][] = [
  ["numeric file", { ...BASE, file: 5 }, "file"],
  ["empty file", { ...BASE, file: "" }, "file"],
  ["string lineRange", { ...BASE, lineRange: "x" }, "lineRange"],
  ["reversed lineRange", { ...BASE, lineRange: [22, 14] }, "lineRange"],
  ["line 0", { ...BASE, lineRange: [0, 4] }, "lineRange"],
  ["one-element lineRange", { ...BASE, lineRange: [4] }, "lineRange"],
  ["empty message", { ...BASE, message: "" }, "message"],
  ["legacy line_start/line_end", { severity: "nit", message: "m", file: "a.py", line_start: 1, line_end: 2 }, ""],
];

describe("validateGolden refuses the finding shapes post_review_comment refuses (#294)", () => {
  it.each(REFUSED)("%s", async (_name, finding, field) => {
    expect(findingSchema.safeParse(finding).success).toBe(false);
    const r = await validateWithFinding(finding);
    expect(r.ok).toBe(false);
    const at = "golden_review.findings[0]" + (field ? `.${field}` : "");
    expect(r.findings.map((f) => f.jsonPath)).toContain(at);
  });

  // Controls: green before and after. Each anchor shape the tool accepts.
  it.each([
    ["file + lineRange", BASE],
    ["file only", { severity: "nit", message: "m", file: "a.py" }],
    ["lineRange only", { severity: "blocker", message: "m", lineRange: [3, 3] }],
    ["no anchor", { severity: "praise", message: "m" }],
  ] as [string, Record<string, unknown>][])("accepts %s", async (_name, finding) => {
    expect((await validateWithFinding(finding)).findings).toEqual([]);
  });

  // A field the hand-written checks already report is not reported twice.
  it("a wrong severity is one finding, under its existing code", async () => {
    const r = await validateWithFinding({ ...BASE, severity: "catastrophic" });
    expect(r.findings.map((f) => f.code)).toEqual(["golden_review.findings[0].severity_wrong_value"]);
  });
});

describe("what validateGolden accepts, post_review_comment can post (#294)", () => {
  const VALUES: unknown[] = [null, 0, -1, 1.5, "", "x", [], [1], [2, 1], [1, 2], {}, true];
  const KEYS = ["severity", "message", "file", "lineRange", "line_start"];

  it("every single-field mutant agrees with findingSchema", async () => {
    let accepted = 0;
    let refused = 0;
    for (const key of KEYS) {
      for (const value of VALUES) {
        const finding = { ...BASE, [key]: value };
        const schemaOk = findingSchema.safeParse(finding).success;
        const validatorOk = (await validateWithFinding(finding)).ok;
        expect(validatorOk, `${key}=${JSON.stringify(value)}`).toBe(schemaOk);
        if (schemaOk) accepted++;
        else refused++;
      }
    }
    // Guards against a table where every mutant lands on one side.
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});
