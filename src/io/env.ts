/**
 * Environment-variable reader that treats a set-but-empty value as unset (#124).
 *
 * This repo had four env-reading sites and three conventions:
 *
 *   src/bin/trace-server.ts   Number(process.env.PORT) || 8766          correct
 *   test/trace/pg-store.test  DATABASE_URL ? it : it.skip               correct
 *   src/eval/comment.ts       process.env.GITHUB_TOKEN ?? GH_TOKEN      BUG
 *   src/trace/pg-store.ts     opts.x ?? process.env.DATABASE_URL ?? d   BUG
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
