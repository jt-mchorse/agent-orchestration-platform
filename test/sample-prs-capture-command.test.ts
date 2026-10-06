/**
 * SCHEMA.md's capture command produces what the fixtures and the validator expect (#165).
 *
 * It read `--jq '<pr-fields>'` (a jq parse error) and pointed at a shape in
 * docs/use-case.md that never existed; the raw API object fails validation
 * (`pr.base must be a string, got object`). And its merge kept `files: .[1]`,
 * the first page only: `--paginate` prints one array per page (with
 * `?per_page=10` a 35-file PR kept 10). Verified for the PR by capturing
 * vsas#6 with these commands: validate ok, findings=0, same keys and the same
 * 35 files in order as the committed fixture.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "..", "fixtures", "sample-prs");
const schema = readFileSync(path.join(DIR, "SCHEMA.md"), "utf8");
const block = schema.slice(schema.indexOf("## Capture command"));

function prShapeKeys(): string[] {
  const m = block.match(/pulls\/<N> \\\s*\n\s*--jq '\{([^}]*)\}'/);
  expect(m, "the PR --jq shape is spelled out").not.toBeNull();
  return (m?.[1] ?? "")
    .split(",")
    .map((part) => (part.split(":")[0] ?? "").trim());
}

describe("SCHEMA.md capture command (#165)", () => {
  it("has no placeholder inside a --jq expression", () => {
    for (const expr of block.matchAll(/--jq '([^']*)'/g)) {
      expect(expr[1]).not.toMatch(/<[^>]+>/);
    }
  });

  it("the documented PR shape has exactly every committed fixture's pr keys", () => {
    const keys = prShapeKeys().sort();
    // The PR fixtures, not their `.golden.json` review labels.
    const fixtures = readdirSync(DIR).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".golden.json"),
    );
    expect(fixtures).toHaveLength(2);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      const pr = JSON.parse(readFileSync(path.join(DIR, f), "utf8")).pr;
      expect(Object.keys(pr).sort(), f).toEqual(keys);
    }
  });

  it("merges every page of files, not the first", () => {
    expect(block).toContain("files: (.[1:] | add)");
    expect(block).not.toContain("files: .[1]}");
  });
});
