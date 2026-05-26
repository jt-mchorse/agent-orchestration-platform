// README decision-range upper-bound lock.
//
// Sister to `chunking-strategies-lab` `tests/test_readme_snapshot.py`
// `test_decision_range_cites_latest_active` (pattern leader), plus the
// Python propagations in `llm-eval-harness`, `llm-cost-optimizer`,
// `prompt-regression-suite`, `rag-production-kit`,
// `embedding-model-shootout`, `vector-search-at-scale`, and
// `python-async-llm-pipelines`. This is the first TypeScript propagation.
//
// The README cites a range like `D-002…D-NNN`; the upper bound must
// equal the highest active (non-superseded) D-NNN in
// `MEMORY/core_decisions_ai.md`. A new decision landing without the
// README being updated fails this test loud — the same drift class
// that `test/architecture-doc.test.ts` catches inside
// `docs/architecture.md`, but for the README's range citation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const README_PATH = resolve(REPO_ROOT, "README.md");
const DECISIONS_PATH = resolve(REPO_ROOT, "MEMORY/core_decisions_ai.md");

function maxActiveDecisionId(): number {
  const text = readFileSync(DECISIONS_PATH, "utf-8");
  const blocks = text.split(/\n(?=- id:)/);
  let best = 0;
  for (const block of blocks) {
    const idMatch = block.match(/- id:\s*D-(\d+)/);
    if (!idMatch || idMatch[1] === undefined) continue;
    const supMatch = block.match(/superseded_by:\s*(\S+)/);
    const supValue = supMatch?.[1];
    const isActive =
      supValue === undefined || supValue.trim().toLowerCase() === "null";
    if (isActive) {
      const n = Number.parseInt(idMatch[1], 10);
      if (n > best) best = n;
    }
  }
  return best;
}

describe("README decision-range upper bound", () => {
  it("cites D-002…D-N with N equal to the highest active decision in MEMORY", () => {
    const body = readFileSync(README_PATH, "utf-8");
    const pattern = /D-0*2\s*(?:…|\.\.\.)\s*D-0*(\d+)/g;
    const matches = Array.from(body.matchAll(pattern)).map((m) =>
      Number.parseInt(m[1]!, 10),
    );
    expect(
      matches.length,
      "README.md must cite the active-decision range as `D-002…D-NNN` " +
        "somewhere (the architecture-section summary paragraph by " +
        "convention). Not found.",
    ).toBeGreaterThan(0);
    const cited = Math.max(...matches);
    const latest = maxActiveDecisionId();
    expect(
      cited,
      `README.md cites decision range up to D-${String(cited).padStart(3, "0")}, ` +
        `but the highest active D-NNN in MEMORY/core_decisions_ai.md is ` +
        `D-${String(latest).padStart(3, "0")}. Update the README's ` +
        `architecture-section summary to D-002…D-${String(latest).padStart(3, "0")}.`,
    ).toBe(latest);
  });
});
