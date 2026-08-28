/**
 * Environment-variable reader that treats a set-but-empty value as unset (#124).
 *
 * This repo had **six** env-reading sites and four conventions. #124 enumerated
 * four of them and fixed the two it labelled BUG; the two it missed both read
 * `PORTFOLIO_ROOT`, and `mcp-server/` was outside its scope entirely (#131):
 *
 *     src/bin/trace-server.ts        Number(process.env.PORT) || 8766        correct
 *     test/trace/pg-store.test       DATABASE_URL ? it : it.skip             correct
 *     src/eval/comment.ts            process.env.GITHUB_TOKEN ?? GH_TOKEN    BUG (#124)
 *     src/trace/pg-store.ts          opts.x ?? process.env.DATABASE_URL ?? d BUG (#124)
 *     src/tools/get-portfolio-context.ts   !root || root.length === 0        BUG (#131)
 *     mcp-server/portfolio-context/bin.ts  !root || root.length === 0        BUG (#131)
 *
 * The count is now discovered, not asserted: `test/io/env-read-population.test.ts`
 * walks the source for `process.env` reads and requires each to go through this
 * module, so a seventh site is covered by a test written today rather than by
 * someone remembering to update this comment.
 *
 * `??` fires on `null`/`undefined` only, so an empty variable is passed through
 * verbatim and whatever follows in the chain is never consulted. Measured on
 * `resolveToken`:
 *
 *   GITHUB_TOKEN='' + GH_TOKEN set     THROWS "GitHub token missing ..."  <- GH_TOKEN ignored
 *   GITHUB_TOKEN='  ' + GH_TOKEN set   -> "  "                            <- sent as a Bearer token
 *
 * The first names, in its own error text, the variable that *is* correctly set.
 * The second is worse: `"  "` is truthy, so it slips past the existing `!env`
 * guard and goes out as `Authorization: Bearer   `, turning a clear "token
 * missing" into a 401 from GitHub.
 *
 * Reachability is ordinary rather than contrived. `GITHUB_TOKEN` is not
 * automatically present in a GitHub Actions job — it has to be mapped, and
 * `env: GITHUB_TOKEN: ${{ secrets.SOMETHING }}` with an unset or misspelled
 * secret expands to an **empty string, not to unset**. Locally, `GH_TOKEN` is
 * the `gh` CLI's own convention, so "GH_TOKEN correct, GITHUB_TOKEN empty" is
 * a normal state.
 */

/**
 * First non-blank value among `names`, else `undefined`.
 *
 * Trimming is part of the contract, not a convenience: an untrimmed credential
 * is the case that used to slip through truthy, and a caller that wants the
 * raw text of a variable should read `process.env` directly.
 */
export function firstNonBlankEnv(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of names) {
    const value = (env[name] ?? "").trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

/**
 * First non-blank value among `candidates`, else `fallback`.
 *
 * `candidates` is a plain list rather than a name list so an explicit option
 * can be threaded in ahead of the environment — the precedence
 * `opts.connectionString` > `DATABASE_URL` > default is expressed by argument
 * order, and an *empty* explicit option falls through, which is what
 * `resolveToken`'s `if (opts.token)` already did correctly for its own option.
 */
export function firstNonBlank(candidates: readonly (string | undefined)[], fallback: string): string {
  for (const candidate of candidates) {
    const value = (candidate ?? "").trim();
    if (value.length > 0) return value;
  }
  return fallback;
}

/**
 * Resolve `PORTFOLIO_ROOT`, or `undefined` when it is unset or blank.
 *
 * Two call sites read this variable — `src/tools/get-portfolio-context.ts` and
 * `mcp-server/portfolio-context/bin.ts` — and both carried a byte-identical
 * copy of
 *
 * ```ts
 * if (!portfolioRoot || portfolioRoot.length === 0) { reject }
 * ```
 *
 * which is the guard the docstring at the top of this file describes as the
 * thing `"  "` slips past. Neither appeared in that enumeration: it listed four
 * sites and there are six, and `mcp-server/` was outside its scope entirely.
 *
 * The second clause is also dead — `!portfolioRoot` is already true for `""` —
 * so the guard covered one case twice and the case that matters not at all.
 *
 * `PORTFOLIO_ROOT` is joined into a filesystem path
 * (`decisionsFilePath` → `path.join(portfolioRoot, "repos", …)`), which makes
 * the blank-but-truthy value worse than a missing one. Measured:
 *
 * ```
 * ""                 rejected
 * "   "              accepted -> "   /repos/leh/MEMORY/core_decisions_ai.md"
 * "  /real/root  "   accepted -> "  /real/root  /repos/leh/MEMORY/..."
 * ```
 *
 * The last is the realistic case: a *correct* path carrying incidental
 * whitespace from a `.env` line, a YAML value, or `$(cat path.txt)`. It becomes
 * a **relative** path under a directory literally named two spaces, and the
 * operator sees `ENOENT` several frames down naming a path with invisible
 * characters at both ends, instead of "PORTFOLIO_ROOT is not set correctly" at
 * the seam that read it.
 *
 * Returning the *trimmed* value is half the fix and not a detail: rejecting
 * blanks while still joining the untrimmed string would fix the rejection and
 * keep the broken path.
 *
 * Returns `undefined` rather than throwing so each caller keeps its own failure
 * report — the CLI exits 2 on stderr, the tool raises `ToolError` — which is
 * the one thing that legitimately differs between them.
 */
export function resolvePortfolioRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return firstNonBlankEnv(["PORTFOLIO_ROOT"], env);
}
