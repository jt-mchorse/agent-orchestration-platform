/**
 * Environment-variable reader that treats a set-but-empty value as unset (#124).
 *
 * This repo had **six** env-reading sites and four conventions. #124 enumerated
 * four of them and fixed the two it labelled BUG; the two it missed both read
 * `PORTFOLIO_ROOT`, and `mcp-server/` was outside its scope entirely (#131):
 *
 *     src/bin/trace-server.ts        Number(process.env.PORT) || 8766        BUG (#132)
 *     test/trace/pg-store.test       DATABASE_URL ? it : it.skip             correct
 *     src/eval/comment.ts            process.env.GITHUB_TOKEN ?? GH_TOKEN    BUG (#124)
 *     src/trace/pg-store.ts          opts.x ?? process.env.DATABASE_URL ?? d BUG (#124)
 *     src/tools/get-portfolio-context.ts   !root || root.length === 0        BUG (#131)
 *     mcp-server/portfolio-context/bin.ts  !root || root.length === 0        BUG (#131)
 *
 * The PORT row read `correct` until #132. It is correct about the
 * blank-but-truthy class this module is named for, and wrong about every other
 * invalid value: see `resolveIntEnv` below.
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

/**
 * Resolve a numeric environment variable, or `fallback` when it is unset or
 * blank. Throws `RangeError` on anything else that is not a plain base-10
 * integer inside `[min, max]`.
 *
 * ### Why this exists
 *
 * `src/bin/trace-server.ts` read `Number(process.env.PORT) || 8766`, and this
 * module's own table labelled that site **correct**. It was correct about the
 * class #124 was chasing — `Number("  ")` is `0`, which is falsy, so a blank
 * value really does fall through to the default — and that true statement
 * excused the site from the population check in
 * `test/io/env-read-population.test.ts` while a different defect sat in the
 * same expression (#132). A true reason for an over-broad exclusion is harder
 * to spot than a false one, because re-reading confirms it.
 *
 * What `Number(...) || default` actually implements is "reject the values that
 * are falsy, pass through the values that are truthy", which is not the same
 * rule as "accept a valid port". Measured:
 *
 *     "8080"      ->  8080    ok
 *     "" / "  "   ->  8766    ok, the #124 contract
 *     "0"         ->  8766    port 0 means "let the OS pick a free port" - overridden
 *     "abc"       ->  8766    a typo silently becomes the default
 *     "8080abc"   ->  8766    ditto, and this one looks like it should work
 *     "-1"        ->  -1      truthy, so it passes through and listen() throws
 *     "70000"     ->  70000   out of range, same
 *
 * The invalid values that got rejected were the ones truthiness happens to
 * catch. A prior session deferred this on the grounds that "`server.listen()`
 * already throws a clear RangeError, so it fails cleanly" — true of `-1` and
 * `70000`, and false of the other three.
 *
 * ### The grammar
 *
 * Trim, gate on `^[+-]?\d+$`, bound the magnitude with `BigInt` *before*
 * `Number` can lose precision, then parse. That is the grammar
 * `mcp-server-cookbook` settled in #98/#137/#152 and enforces there across
 * three servers, so the two repos do not solve one problem two ways. It
 * rejects `0x10`, `1e3`, `8080.0`, `1_000`, `" 5s"` and `"9007199254740993"`
 * (which `Number` silently reads one lower) as well as the cases above.
 *
 * One deliberate difference from mcp's version: **unset or blank falls back**,
 * where mcp's throws on `""`. That is #124's contract for this repo — a
 * set-but-empty variable is treated as unset — and it is what keeps `PORT=`
 * and `PORT="  "` resolving to the default.
 *
 * Throwing rather than warning-and-defaulting: this is boot-time operator
 * input, read once, with stderr in front of the operator, so failing fast
 * costs one restart while absorbing costs a server on the wrong port with no
 * signal. Same argument `commentTargetError` (#107) and `AgentRun.maxReplans`
 * already won here. It deliberately does **not** settle #127, which asks the
 * same question about a *request-time* query parameter — per-request and
 * reachable by anyone, where absorb-and-default has a real case (D-014).
 */
export function resolveIntEnv(
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return fallback;

  const plainInteger =
    /^[+-]?\d+$/.test(trimmed) &&
    BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER) &&
    BigInt(trimmed) >= -BigInt(Number.MAX_SAFE_INTEGER);
  const value = plainInteger ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `env ${name} must be an integer in [${min}, ${max}] written in plain base-10 ` +
        `digits (no unit suffix, no scientific notation, no separators, no hex); ` +
        `got ${JSON.stringify(raw)}. Leave it unset or empty to use the default ${fallback}.`,
    );
  }
  return value;
}

/** Lowest and highest values `server.listen(port)` accepts; 0 asks the OS to pick. */
export const PORT_RANGE = { min: 0, max: 65535 } as const;

/**
 * Resolve `PORT`, or `fallback` when it is unset or blank (#132).
 *
 * `0` is honoured rather than overridden: it is the standard "let the OS pick
 * a free port" request, which container and test harnesses use, and
 * `Number(...) || default` could not express it at all.
 */
export function resolvePort(fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  return resolveIntEnv("PORT", fallback, PORT_RANGE, env);
}
