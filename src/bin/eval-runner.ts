/**
 * `npm run eval` — run the agent eval suite + write/post sticky comment.
 *
 * Two modes:
 *   --comment        upsert a sticky comment to the configured PR.
 *   --dry-run        skip the upsert; print the rendered markdown to stdout.
 *
 * Both modes write `results/eval-<timestamp>.json` with the full
 * structured run for downstream tooling (savings dashboard, etc.).
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { renderEvalMarkdown, resolveToken, upsertStickyComment } from "../eval/comment.js";
import { commentTargetError, discoverCases, EvalInputError, evaluateAll } from "../eval/runner.js";
import { atomicWriteFile } from "../io/atomic-write.js";

interface CLIArgs {
  fixturesDir: string;
  resultsDir: string;
  comment: boolean;
  dryRun: boolean;
  repo: string | null;
  pr: number | null;
}

function parseArgs(argv: string[]): CLIArgs {
  const args: CLIArgs = {
    fixturesDir: "fixtures/sample-prs",
    resultsDir: "results",
    comment: false,
    dryRun: false,
    repo: null,
    pr: null,
  };
  // Every value is checked before it is used (#161). `argv[++i]` read a flag
  // as the value: `--results-dir --comment` wrote to a directory named
  // `--comment` and swallowed the comment, a trailing `--results-dir` was a raw
  // TypeError, and an unknown flag (`--comments`) was ignored, so the CI step
  // posted nothing at exit 0. `validate.ts` already refuses unknown flags.
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--fixtures-dir") args.fixturesDir = value(i++, a);
    else if (a === "--results-dir") args.resultsDir = value(i++, a);
    else if (a === "--comment") args.comment = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--repo") args.repo = value(i++, a);
    else if (a === "--pr") {
      const raw = value(i++, a);
      if (!/^[1-9][0-9]*$/.test(raw)) throw new UsageError(`--pr must be a positive integer; got ${JSON.stringify(raw)}`);
      args.pr = Number(raw);
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  return args;
}

class UsageError extends Error {}

async function main(): Promise<number> {
  let args: CLIArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`::error::${err.message}`);
    return 2;
  }
  // `--comment`'s own inputs before any fixture runs (#173). The target was
  // checked only after the whole eval and the results write, and a missing
  // token surfaced from inside `upsertStickyComment` as a stack trace at
  // exit 1 -- the crash code, for an operator error.
  if (args.comment && !args.dryRun) {
    // `--pr` is `Number(...)`-coerced (line 44), so a bare falsy check only rejects
    // NaN/0 — a negative, non-finite, or non-integer PR number is truthy and would
    // otherwise flow into `upsertStickyComment` → a GitHub API URL
    // `.../issues/${pr}/comments` unchecked. `commentTargetError` enforces the
    // positive-integer contract (sibling of RetryPolicy/ExecutorOptions #29/#31).
    const targetErr = commentTargetError(args.repo, args.pr);
    if (targetErr) {
      console.error(`::error::${targetErr}`);
      return 2;
    }
    try {
      resolveToken({});
    } catch (err) {
      console.error(`::error::${(err as Error).message}`);
      return 2;
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The bin lives at src/bin/, the fixtures dir is at the repo root.
  const repoRoot = path.resolve(here, "..", "..");
  const fixturesDir = path.isAbsolute(args.fixturesDir)
    ? args.fixturesDir
    : path.join(repoRoot, args.fixturesDir);
  const resultsDir = path.isAbsolute(args.resultsDir)
    ? args.resultsDir
    : path.join(repoRoot, args.resultsDir);

  // A missing/unreadable fixtures dir must surface as the same clean exit-2
  // operator-error as the empty-dir case below, not a raw ENOENT traceback at
  // exit 1 — `validate.ts` translates ENOENT the same way (0/1/2 uniform, see
  // docs/architecture.md). `discoverCases` calls `fs.readdir` unguarded.
  let cases;
  try {
    cases = await discoverCases(fixturesDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = code === "ENOENT" ? "not found" : (err as Error).message;
    console.error(`::error::cannot read fixtures dir ${fixturesDir}: ${detail}`);
    return 2;
  }
  if (cases.length === 0) {
    console.error(`::error::no fixture/golden pairs found under ${fixturesDir}`);
    return 2;
  }
  // Each case's fixture/golden `.json` is operator input, the file-content read
  // sibling of the `discoverCases` readdir guard above (a corrupt or vanished
  // file threw a raw SyntaxError/ENOENT that fell through to the top-level
  // `.catch` at exit 1). `evaluateAll` now raises a typed `EvalInputError` for
  // those; surface it as the same clean exit 2, matching `validate.ts`'s 0/1/2
  // contract. A non-`EvalInputError` (a genuine agent/runtime bug) still
  // propagates to exit 1 unchanged.
  let run;
  try {
    run = await evaluateAll(cases);
  } catch (err) {
    if (err instanceof EvalInputError) {
      console.error(`::error::${err.message}`);
      return 2;
    }
    throw err;
  }
  const md = renderEvalMarkdown(run);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(resultsDir, `eval-${stamp}.json`);
  // `--results-dir` is operator input, the write-seam sibling of the fixtures
  // read guarded above. An unwritable/uncreatable dir makes `atomicWriteFile`'s
  // recursive `mkdir`/rename throw (ENOTDIR when a path component is a file,
  // EACCES, ENOENT), which without this guard fell through to the top-level
  // `.catch` as a raw traceback at exit 1 — the same operator-error the #111
  // read guard and `validate.ts` surface as a clean exit 2 (cross-repo write-seam
  // contract: llm-cost-optimizer#163, python-async-llm-pipelines#85).
  try {
    await atomicWriteFile(
      out,
      JSON.stringify(
        {
          composite_mean: run.composite_mean,
          recommendation_accuracy: run.recommendation_accuracy,
          findings_f1_mean: run.findings_f1_mean,
          cases: run.cases.map((c) => ({
            fixture_id: c.fixture_id,
            score: c.score,
            actual: c.actual,
            golden: c.golden,
          })),
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = code ? `${code}` : (err as Error).message;
    console.error(`::error::cannot write results to ${out}: ${detail}`);
    return 2;
  }
  console.log(md);
  console.log(`\neval results: ${out}`);

  if (args.dryRun) return 0;
  if (!args.comment) return 0;

  // Target and token were checked before the eval (#173). A GitHub refusal (a
  // fork PR's read-only token, a 404) or a network failure here is an I/O
  // error, exit 2, not the crash code.
  let id: number;
  try {
    id = await upsertStickyComment(args.repo as string, args.pr as number, md);
  } catch (err) {
    console.error(`::error::could not post the sticky comment: ${(err as Error).message}`);
    return 2;
  }
  console.log(`sticky comment id=${id} upserted on ${args.repo}#${args.pr}`);
  return 0;
}

// `main()` resolves to the intended exit code (0 ok / 2 operator error). Without
// wiring it to `process.exit`, a resolved promise exits 0 and every non-zero
// signal — including the #108/#110 `--comment` target validation — is swallowed.
// Mirrors `validate.ts`.
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
