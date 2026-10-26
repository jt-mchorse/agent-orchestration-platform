/**
 * `discoverCases` orders cases by code unit, not by the host locale (#270).
 *
 * It sorted with `a.fixture_id.localeCompare(b.fixture_id)`, and that order is
 * the row order of the eval comment and of the byte-locked
 * `docs/eval_snapshot.md`. Measured on main 6a13c88 with the two committed
 * pairs renamed `aa-rag_pr9*` / `zz-vsas_pr6*`: `LANG=en_US.UTF-8` listed
 * `aa, zz`, `LANG=da_DK.UTF-8` listed `zz, aa` (Danish collates "aa" as "å").
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { discoverCases } from "../../src/eval/runner.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "sample-prs");
const PAIR = "rag-production-kit_pr9_hybrid_retrieval";

/** A fixtures dir holding the committed pair once per id in *ids*. */
function fixturesDir(ids: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aop-discover-"));
  for (const id of ids) {
    copyFileSync(path.join(FIXTURES, `${PAIR}.json`), path.join(dir, `${id}.json`));
    copyFileSync(path.join(FIXTURES, `${PAIR}.golden.json`), path.join(dir, `${id}.golden.json`));
  }
  return dir;
}

describe("discoverCases order (#270)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("sorts by code unit: 'B' (U+0042) before 'a' (U+0061) in every locale", async () => {
    // `localeCompare` puts "a" before "B" under every locale's default
    // collation, so this arm does not depend on the host's LANG.
    const dir = fixturesDir(["a-case", "B-case"]);
    dirs.push(dir);
    const ids = (await discoverCases(dir)).map((c) => c.fixture_id);
    expect(ids).toEqual(["B-case", "a-case"]);
  });

  it("gives the same order under LANG=da_DK.UTF-8 as under en_US", () => {
    const dir = fixturesDir(["zz-vsas", "aa-rag"]);
    dirs.push(dir);
    const runner = pathToFileURL(path.join(REPO_ROOT, "src", "eval", "runner.ts")).href;
    const code = `
      const { discoverCases } = await import(${JSON.stringify(runner)});
      const ids = (await discoverCases(${JSON.stringify(dir)})).map((c) => c.fixture_id);
      console.log(JSON.stringify({ ids, aaBeforeZz: "aa".localeCompare("zz") < 0 }));
    `;
    const order = (lang: string) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code],
          {
            cwd: REPO_ROOT,
            env: { ...process.env, LANG: lang, LC_ALL: lang },
            encoding: "utf8",
          },
        ).trim(),
      ) as { ids: string[]; aaBeforeZz: boolean };

    const en = order("en_US.UTF-8");
    const da = order("da_DK.UTF-8");
    // Anti-vacuity: the two children really collate differently, so a
    // locale-dependent sort WOULD show up here.
    expect({ en: en.aaBeforeZz, da: da.aaBeforeZz }).toEqual({ en: true, da: false });
    expect(en.ids).toEqual(["aa-rag", "zz-vsas"]);
    expect(da.ids).toEqual(["aa-rag", "zz-vsas"]);
  }, 60_000);

  it("no localeCompare in src/ outside the #119 site", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const f = path.join(d, n);
        return statSync(f).isDirectory() ? walk(f) : /\.(ts|js)$/.test(n) ? [f] : [];
      });
    const src = path.join(REPO_ROOT, "src");
    const files = walk(src);
    expect(files.length).toBeGreaterThan(10); // anti-vacuity: the walk found the tree
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          // Code lines only: a comment may name the call it avoids.
          /^\s*(\/\/|\*|\/\*)/.test(line) || !line.includes("localeCompare(")
            ? []
            : [`${path.relative(src, f)}:${i + 1}`],
        ),
    );
    // MemoryStore's listRuns ordering is the open decision-revisit #119.
    expect(hits.map((h) => h.replace(/:\d+$/, ""))).toEqual([path.join("trace", "store.ts")]);
  });
});
