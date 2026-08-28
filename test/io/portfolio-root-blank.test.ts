/**
 * A blank-but-truthy `PORTFOLIO_ROOT` is rejected, and a padded one is trimmed
 * before it becomes a path (#131).
 *
 * Both readers carried `if (!root || root.length === 0)`. `!root` is already
 * true for `""`, so the second clause never fires on its own: two clauses, one
 * case covered twice, and `"  "` — the exact value #124's docstring says slips
 * past an `!env` guard — covered by neither.
 *
 * `PORTFOLIO_ROOT` is joined into a filesystem path by `decisionsFilePath`,
 * which makes blank-but-truthy worse than missing. Measured before the fix:
 *
 *     ""                 rejected
 *     "   "              accepted -> "   /repos/leh/MEMORY/core_decisions_ai.md"
 *     "  /real/root  "   accepted -> "  /real/root  /repos/leh/MEMORY/..."
 *
 * The last row is the realistic one: a *correct* path carrying incidental
 * whitespace from a `.env` line, a YAML value, or `$(cat path.txt)` becomes a
 * **relative** path under a directory named two spaces, surfacing as `ENOENT`
 * several frames down with invisible characters at both ends of the name.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePortfolioRoot } from "../../src/io/env.js";

const BLANK = ["", " ", "   ", "\t", " \t ", "\n", " \n "] as const;

describe("resolvePortfolioRoot", () => {
  it("treats an unset variable as unset", () => {
    expect(resolvePortfolioRoot({})).toBeUndefined();
  });

  it.each(BLANK)("treats blank %j as unset", (value) => {
    expect(resolvePortfolioRoot({ PORTFOLIO_ROOT: value })).toBeUndefined();
  });

  it("returns an ordinary value unchanged", () => {
    expect(resolvePortfolioRoot({ PORTFOLIO_ROOT: "/real/root" })).toBe("/real/root");
  });

  it("TRIMS a padded value rather than only accepting it", () => {
    // Half the fix, and not a detail. Rejecting blanks while still returning
    // the untrimmed string would fix the rejection and keep the broken path:
    // `path.join("  /real/root  ", "repos", ...)` is relative, under a
    // directory literally named two spaces.
    expect(resolvePortfolioRoot({ PORTFOLIO_ROOT: "  /real/root  " })).toBe("/real/root");
  });

  it("the trimmed value is what makes a correct absolute path", () => {
    const padded = "  /real/root  ";
    const resolved = resolvePortfolioRoot({ PORTFOLIO_ROOT: padded });
    expect(resolved).toBeDefined();

    const good = join(resolved as string, "repos", "leh", "MEMORY", "core_decisions_ai.md");
    const bad = join(padded, "repos", "leh", "MEMORY", "core_decisions_ai.md");

    expect(good).toBe("/real/root/repos/leh/MEMORY/core_decisions_ai.md");
    expect(good.startsWith("/")).toBe(true);
    // Anti-vacuous: assert the untrimmed join really is broken, so this test
    // fails loudly if `path.join` ever starts trimming on its own and the
    // whole premise stops holding.
    expect(bad.startsWith("/")).toBe(false);
    expect(bad).toContain("  /real/root  ");
  });

  it("defaults to process.env when no env is passed", () => {
    // The production call sites take no argument; a helper that only worked
    // with an injected env would pass every test above and fix nothing.
    const saved = process.env.PORTFOLIO_ROOT;
    try {
      process.env.PORTFOLIO_ROOT = "  /from/process/env  ";
      expect(resolvePortfolioRoot()).toBe("/from/process/env");
      process.env.PORTFOLIO_ROOT = "   ";
      expect(resolvePortfolioRoot()).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PORTFOLIO_ROOT;
      else process.env.PORTFOLIO_ROOT = saved;
    }
  });
});
