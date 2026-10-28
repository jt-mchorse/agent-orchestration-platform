/**
 * Fails the test run when it leaves a new file in `<repo>/results/` (#277).
 *
 * The eval runner writes `results/eval-<timestamp>.json` under the repo root
 * unless it is given `--results-dir`. Tests that spawned it without one left
 * five files per `npm test`: clutter in the checkout, and tests sharing a
 * directory. The directory is gitignored, so nothing else would notice.
 * Listed before the run and again at teardown; vitest exits non-zero when a
 * globalSetup teardown throws. Files that were already there are not touched.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const RESULTS = resolve(__dirname, "..", "..", "results");

function list(): Set<string> {
  try {
    return new Set(readdirSync(RESULTS));
  } catch {
    return new Set();
  }
}

export default function setup(): () => void {
  const before = list();
  return () => {
    const leaked = [...list()].filter((f) => !before.has(f)).sort();
    if (leaked.length > 0) {
      throw new Error(
        `the test run wrote ${leaked.length} file(s) into ${RESULTS}: ${leaked.join(", ")}. ` +
          "Pass a temp --results-dir (or CAPTURE_RESULTS_DIR for scripts/capture_demo.sh) (#277).",
      );
    }
  };
}
