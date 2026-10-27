/**
 * The repo root a bin resolves its repo-relative defaults against (#275).
 *
 * `src/bin/eval-runner.ts` took `path.resolve(here, "..", "..")` ("the bin lives
 * at src/bin/"). After `npm run build` the bin is `dist/src/bin/eval-runner.js`,
 * one level deeper, so the root came out as `dist/`: `--dry-run` exited 2 on
 * `dist/fixtures/sample-prs: not found`, and an explicit `--fixtures-dir` wrote
 * its results to `dist/results/`. A fixed number of `..` hops is right for one
 * layout only. The nearest ancestor holding `package.json` is the same
 * directory from `src/bin/` (tsx) and `dist/src/bin/` (built), because `tsc`
 * does not emit `package.json` into the outDir.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The nearest directory at or above *startDir* that holds a `package.json`. */
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json at or above ${startDir}`);
    dir = parent;
  }
}

/** {@link findRepoRoot} from the directory of the module at *moduleUrl*. */
export function repoRootOf(moduleUrl: string): string {
  return findRepoRoot(path.dirname(fileURLToPath(moduleUrl)));
}
