/**
 * What `validateFixture` accepts, `fetch_pr` can load (#199).
 *
 * The validator exists to catch, before a run, what `fetch_pr` rejects
 * mid-run (#71, #190). It checked `source` and `pr.state` only as "any
 * string" while `fetch_pr` types them `z.literal("github")` and
 * `z.enum(["open", "closed"])`. A fixture with `source: "github.com"`
 * validated clean, `fetch_pr` skipped it as not_found, and the eval still
 * printed a scored comment at exit 0.
 *
 * Differential, so the next narrowing in fetch_pr's schema shows up here
 * without anyone listing it. Every string leaf of every committed fixture is
 * replaced with a junk value, and every mutant the validator accepts must parse
 * under `fetchPrTool.outputSchema`, fetch_pr's own schema.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateFixture } from "../../src/eval/validate.js";
import { fetchPrTool } from "../../src/tools/fetch-pr.js";

const FIXTURES = path.join(__dirname, "..", "..", "fixtures", "sample-prs");
const JUNK = "not-a-recognised-value";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Paths to every string leaf, e.g. ["pr", "state"] or ["files", 0, "status"]. */
function stringLeaves(v: Json, at: Array<string | number> = []): Array<Array<string | number>> {
  if (typeof v === "string") return [at];
  if (Array.isArray(v)) return v.flatMap((x, i) => stringLeaves(x, [...at, i]));
  if (v !== null && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => stringLeaves(x, [...at, k]));
  }
  return [];
}

function withLeaf(v: Json, at: Array<string | number>, value: string): Json {
  const copy = JSON.parse(JSON.stringify(v)) as Json;
  let node = copy as Record<string | number, Json>;
  for (const key of at.slice(0, -1)) node = node[key] as Record<string | number, Json>;
  node[at[at.length - 1]!] = value;
  return copy;
}

let dir = "";
let fixtures: Array<[string, Json]> = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aop-199-"));
  const names = (await readdir(FIXTURES)).filter(
    (n) => n.endsWith(".json") && !n.endsWith(".golden.json"),
  );
  fixtures = await Promise.all(
    names.map(async (n) => [n, JSON.parse(await readFile(path.join(FIXTURES, n), "utf8"))] as [string, Json]),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("validateFixture accepts only what fetch_pr can load (#199)", () => {
  it("the committed fixtures pass both", async () => {
    // Anti-vacuity: there are fixtures, and they are valid to both readers.
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    for (const [name, fx] of fixtures) {
      const p = path.join(dir, name);
      await writeFile(p, JSON.stringify(fx), "utf8");
      expect((await validateFixture(p)).ok, name).toBe(true);
      expect(fetchPrTool.outputSchema.safeParse(fx).success, name).toBe(true);
    }
  });

  it("no string mutation passes the validator and fails fetch_pr", async () => {
    const accepted: string[] = [];
    const leaky: string[] = [];
    for (const [name, fx] of fixtures) {
      for (const at of stringLeaves(fx)) {
        const mutant = withLeaf(fx, at, JUNK);
        const p = path.join(dir, `m-${name}`);
        await writeFile(p, JSON.stringify(mutant), "utf8");
        if (!(await validateFixture(p)).ok) continue;
        accepted.push(at.join("."));
        if (!fetchPrTool.outputSchema.safeParse(mutant).success) leaky.push(`${name}: ${at.join(".")}`);
      }
    }
    // Anti-vacuity: free-text fields (title, body, filename, patch) are accepted.
    expect(accepted.length).toBeGreaterThan(10);
    expect(leaky, "the validator passes these, fetch_pr rejects them").toEqual([]);
  });

  it.each([
    ["source", ["source"], "source_wrong_value"],
    ["pr.state", ["pr", "state"], "pr.state_wrong_value"],
  ] as const)("names %s", async (_label, at, code) => {
    const [name, fx] = fixtures[0]!;
    const p = path.join(dir, `named-${name}`);
    await writeFile(p, JSON.stringify(withLeaf(fx, [...at], "github.com")), "utf8");
    const r = await validateFixture(p);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain(code);
  });
});
