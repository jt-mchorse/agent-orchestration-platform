/**
 * Every `process.env` read goes through `src/io/env.ts` (#131).
 *
 * `#124` fixed the blank-but-truthy class and recorded its scope as a prose
 * list of four sites. There were six. The two it missed both read
 * `PORTFOLIO_ROOT` with the exact guard #124 replaced —
 * `!root || root.length === 0`, which accepts `"  "` — and one of them lives
 * under `mcp-server/`, outside the sweep's scope entirely.
 *
 * A comment cannot enforce a population and a hand-written list cannot see a
 * new member, so the count is discovered here instead. Same lesson as
 * `nextjs-streaming-ai-patterns#112` (a lock that listed its three modules
 * could not catch a fourth).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** Directories that ship runtime code. `test/` legitimately manipulates env. */
const SOURCE_DIRS = ["src", "mcp-server"] as const;

/**
 * Sites that read `process.env` directly, by deliberate exception.
 *
 * Naming them is the point: an *asserted* exception is re-examined when it
 * changes, whereas an omission is invisible. `env.ts` is the helper itself —
 * it has to touch `process.env`.
 *
 * `src/bin/trace-server.ts` was the second entry, excused because it "resolves
 * a numeric port through `Number(...) || default`, which has no
 * blank-but-truthy hazard because `Number("  ")` is `0`, i.e. falsy". Every
 * word of that is true, and it excused the site from this rule while a
 * different defect sat in the same expression: `PORT=0` was unreachable and
 * `PORT=abc` silently became the default (#132). A *true* reason for an
 * exclusion is harder to spot than a false one, because re-reading confirms
 * it — so the question to ask of an exemption is not "is the reason true" but
 * "does the reason cover everything the exemption covers". It is now routed
 * through `resolvePort` and the exemption is gone.
 */
const DELIBERATE_DIRECT_READERS = new Set(["src/io/env.ts"]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Strip comments so the prose *describing* the old shape isn't counted. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The helpers that make a `process.env` read safe. */
const ENV_HELPERS = /\b(firstNonBlankEnv|firstNonBlank|resolvePortfolioRoot|resolveIntEnv|resolvePort)\b/;

/**
 * Files that read `process.env` without routing it through `src/io/env.ts`.
 *
 * Stated positively — what must be *present* — rather than as "must not read
 * `process.env`". The negative form flags correct code: `src/eval/comment.ts`
 * and `src/trace/pg-store.ts` both read `process.env` on purpose, to thread an
 * explicit option ahead of the environment, and hand the result to
 * `firstNonBlank`. A rule that fails on code that is right is worse than no
 * rule, so the requirement is that the value reaches a helper.
 */
function unguardedEnvReaders(): string[] {
  const offenders: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of tsFilesUnder(join(REPO_ROOT, dir))) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      if (DELIBERATE_DIRECT_READERS.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (/process\.env/.test(code) && !ENV_HELPERS.test(code)) offenders.push(rel);
    }
  }
  return offenders.sort();
}

/** Files that read `process.env` at all, guarded or not — the population. */
function allEnvReaders(): string[] {
  const found: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of tsFilesUnder(join(REPO_ROOT, dir))) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      if (/process\.env/.test(stripComments(readFileSync(file, "utf8")))) found.push(rel);
    }
  }
  return found.sort();
}

describe("env-read population", () => {
  it("finds source files to check at all", () => {
    // Anti-vacuous: `directEnvReaders()` returning `[]` is the pass condition
    // below, and a broken walk would return `[]` too.
    const files = SOURCE_DIRS.flatMap((d) => tsFilesUnder(join(REPO_ROOT, d)));
    expect(files.length).toBeGreaterThan(10);
  });

  it("every deliberate direct reader actually exists and actually reads env", () => {
    // An exception list that names a deleted or refactored file silently widens
    // the rule. Both halves matter: the file must exist, and it must still be
    // doing the thing it is excused for.
    for (const rel of DELIBERATE_DIRECT_READERS) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(stripComments(src), `${rel} no longer reads process.env`).toMatch(/process\.env/);
    }
  });

  it("every env read routes through src/io/env.ts", () => {
    expect(unguardedEnvReaders()).toEqual([]);
  });

  it("the walk actually reaches env-reading files", () => {
    // Anti-vacuous for the rule above: `[]` offenders is also what a broken
    // walk returns. `src/eval/comment.ts` and `src/trace/pg-store.ts` read
    // `process.env` deliberately, to thread an explicit option ahead of the
    // environment, so they are the proof the scan sees anything at all.
    const readers = allEnvReaders();
    expect(readers).toContain("src/eval/comment.ts");
    expect(readers).toContain("src/trace/pg-store.ts");
    // Was `>= 4` while `src/bin/trace-server.ts` read `process.env.PORT`
    // directly. #132 routed it through `resolvePort`, so the population of
    // *direct* readers legitimately shrank by one. The named files above are
    // what actually makes this arm non-vacuous; the count is a floor under
    // them, so it moves when the population does rather than being a second
    // hard-coded list.
    expect(readers.length).toBeGreaterThanOrEqual(3);
  });

  it("both #131 sites resolve PORTFOLIO_ROOT through the shared helper", () => {
    // The outcome, pinned directly. These two no longer appear in
    // `allEnvReaders()` at all — which is the fix — so the rule above cannot
    // be what keeps them honest. One reads it under `mcp-server/`, the
    // directory #124's scope never covered.
    for (const rel of [
      "src/tools/get-portfolio-context.ts",
      "mcp-server/portfolio-context/bin.ts",
    ]) {
      const code = stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
      expect(code, `${rel} should call resolvePortfolioRoot`).toMatch(/resolvePortfolioRoot\(/);
      expect(code, `${rel} should not read PORTFOLIO_ROOT directly`).not.toMatch(/process\.env/);
      // The old guard shape, in either copy, is what this issue removed.
      expect(code, `${rel} still has the blank-but-truthy guard`).not.toMatch(
        /\.length === 0/,
      );
    }
  });

  it("the rule catches an unguarded read and spares a guarded one", () => {
    // The real predicate over constructed source, both directions, so a broken
    // regex cannot pass by flagging nothing or by flagging everything.
    const unguarded = 'const root = process.env["PORTFOLIO_ROOT"];';
    const guarded = 'const root = firstNonBlankEnv(["PORTFOLIO_ROOT"], process.env);';
    const commentOnly = '// was: const root = process.env["PORTFOLIO_ROOT"];';

    const offends = (code: string): boolean => {
      const c = stripComments(code);
      return /process\.env/.test(c) && !ENV_HELPERS.test(c);
    };
    expect(offends(unguarded)).toBe(true);
    expect(offends(guarded)).toBe(false);
    expect(offends(commentOnly)).toBe(false);
  });
});
