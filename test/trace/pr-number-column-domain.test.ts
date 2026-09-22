/**
 * `pr.number`'s guards must match the column it lands in (#145).
 *
 * D-015 (#143) matched `aggregateCost`'s three summands to their destinations:
 *
 *     total_cost_dollars  NUMERIC(12, 6)  ->  quantised, magnitude-bounded
 *     total_input_tokens  BIGINT          ->  Number.isSafeInteger
 *     total_output_tokens BIGINT          ->  Number.isSafeInteger
 *
 * `runs` has a fourth numeric column, and it is the narrowest in the schema:
 *
 *     pr_number         INTEGER NOT NULL,
 *
 * PostgreSQL `INTEGER` is 32-bit: max 2,147,483,647. Every guard on this value
 * used `Number.isInteger` with no ceiling, so the accepted domain ran to
 * `Number.MAX_SAFE_INTEGER` -- about 4.2 million times the column's. Measured
 * before the fix:
 *
 *     pr=2147483647         guard=ACCEPTED  storableInINTEGER=true
 *     pr=2147483648         guard=ACCEPTED  storableInINTEGER=false
 *     pr=3000000000         guard=ACCEPTED  storableInINTEGER=false
 *     pr=9007199254740991   guard=ACCEPTED  storableInINTEGER=false
 *
 *     MemoryStore round-tripped pr.number = 3000000000
 *
 * The harm is backend parity, exactly as D-015 measured it for dollars:
 * `MemoryStore` stores it and returns it, `PgStore` hands it to the `INTEGER`
 * column and gets `22003 numeric value out of range`. The same input succeeds on
 * one store and fails on the other -- #142's "a failure visible only in the
 * `DATABASE_URL`-gated job".
 *
 * Two arms here are green on both trees and are the ones that reject the wrong
 * neighbours:
 *
 *   - `the other integer fields keep their unbounded domain` rejects bounding
 *     all five fields that share `validate.ts`'s integer helper. Only
 *     `pr.number` has an `INTEGER` column behind it; `additions`, `deletions`,
 *     `changed_files` and `changes` are never persisted to `runs` at all, so a
 *     storage bound on them would be a constraint with no storage.
 *   - `the bound is INTEGER's, not BIGINT's` rejects reaching for
 *     `Number.isSafeInteger` -- the domain the *other two* numeric columns
 *     take, and therefore the plausible copy from one function away.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { commentTargetError } from "../../src/eval/runner.js";
import { MAX_PR_NUMBER, MemoryStore } from "../../src/trace/store.js";
import { validateFixture } from "../../src/eval/validate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INIT_SQL = resolve(HERE, "..", "..", "infra", "postgres", "init.sql");
const REAL_FIXTURE = "rag-production-kit_pr9_hybrid_retrieval.json";

/** The type `init.sql` declares for `runs.pr_number`, read rather than assumed. */
function declaredPrNumberType(): string {
  const ddl = readFileSync(INIT_SQL, "utf8");
  const match = /pr_number\s+(\w+)/i.exec(ddl);
  if (!match) throw new Error("pr_number is no longer declared in infra/postgres/init.sql");
  return match[1]!.toUpperCase();
}

function run(prNumber: number) {
  return {
    run_id: "r1",
    pr: { owner: "o", repo: "n", number: prNumber },
    events: [],
    review: { recommendation: "comment" as const, summary: "s", findings: [] },
  };
}

// ---------------------------------------------------------------------------
// The constant is the schema's, not a literal someone typed
// ---------------------------------------------------------------------------

describe("MAX_PR_NUMBER comes from the DDL", () => {
  it("pr_number is still an INTEGER column", () => {
    expect(declaredPrNumberType()).toBe("INTEGER");
  });

  it("and the constant is that column's ceiling, derived rather than retyped", () => {
    // D-015's own note: "a magic constant copied from a schema is a second copy
    // of the schema". Derive it from the width the DDL declares so the two
    // cannot drift -- if the column ever widens to BIGINT this fails loudly
    // instead of silently leaving a stale, too-narrow bound in place.
    const declared = declaredPrNumberType();
    const bits = declared === "INTEGER" ? 32 : declared === "SMALLINT" ? 16 : 64;
    expect(MAX_PR_NUMBER).toBe(2 ** (bits - 1) - 1);
  });
});

// ---------------------------------------------------------------------------
// The boundary, not a round number
// ---------------------------------------------------------------------------

describe("the store seam bounds pr.number", () => {
  it("accepts exactly INTEGER's maximum", async () => {
    const store = new MemoryStore();
    await store.writeRun(run(MAX_PR_NUMBER) as never);
    const got = await store.getRun("r1");
    expect((got as never as { pr: { number: number } }).pr.number).toBe(MAX_PR_NUMBER);
  });

  it("rejects one past it", async () => {
    const store = new MemoryStore();
    await expect(store.writeRun(run(MAX_PR_NUMBER + 1) as never)).rejects.toThrow(
      /pr\.number must be an integer in \[1, 2147483647\]/,
    );
  });

  it("rejects the value that round-tripped before the fix", async () => {
    const store = new MemoryStore();
    await expect(store.writeRun(run(3e9) as never)).rejects.toThrow(/3000000000/);
  });

  it("still rejects what it always rejected", async () => {
    const store = new MemoryStore();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store.writeRun(run(bad) as never)).rejects.toThrow(TypeError);
    }
  });

  it("refuses rather than storing a partial run", async () => {
    // The opposite posture to `aggregateCost`, deliberately: that skips a bad
    // observation to degrade to a partial total. `pr.number` is which pull
    // request the run is *about*, so there is no partial answer -- and a run
    // persisted under a silently-altered PR number is worse than one not
    // persisted. Asserted rather than left implied.
    const store = new MemoryStore();
    await expect(store.writeRun(run(3e9) as never)).rejects.toThrow();
    expect(await store.getRun("r1")).toBeNull();
  });

  it("the bound is INTEGER's, not BIGINT's", () => {
    // The plausible wrong copy is `Number.isSafeInteger`, which is what the two
    // *other* numeric columns in this table take (#143). It would accept every
    // value in the measured table above.
    expect(Number.isSafeInteger(3e9)).toBe(true);
    expect(3e9 > MAX_PR_NUMBER).toBe(true);
    expect(MAX_PR_NUMBER).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

// ---------------------------------------------------------------------------
// The CLI keeps its own message
// ---------------------------------------------------------------------------

describe("commentTargetError", () => {
  it("names the column rather than letting Postgres do it", () => {
    expect(commentTargetError("o/n", MAX_PR_NUMBER + 1)).toMatch(/runs\.pr_number/);
  });

  it("accepts the boundary and the ordinary case", () => {
    expect(commentTargetError("o/n", MAX_PR_NUMBER)).toBeNull();
    expect(commentTargetError("o/n", 42)).toBeNull();
  });

  it("keeps its existing lower-bound message unchanged", () => {
    expect(commentTargetError("o/n", 0)).toMatch(/must be a positive integer/);
  });
});

// ---------------------------------------------------------------------------
// Green on both trees: what rejects the over-broad neighbour
// ---------------------------------------------------------------------------

describe("the other integer fields keep their unbounded domain", () => {
  it("additions / deletions / changed_files accept values past INTEGER's max", async () => {
    // These share `validate.ts`'s integer helper with `pr.number` and have no
    // column behind them -- they are fixture counts, never written to `runs`.
    // A neighbour that bounded the shared helper would impose a storage
    // constraint on fields with no storage, and this arm is what catches it.
    //
    // Driven through the real `validateFixture`, which reads a file, so the
    // fixture is written to a temp path rather than passed as an object --
    // otherwise this would be testing a helper the CLI does not call.
    // Shape taken from a committed fixture so the arm exercises the real
    // schema rather than a guess at it; only the three counts are perturbed.
    const real = JSON.parse(
      readFileSync(
        resolve(HERE, "..", "..", "fixtures", "sample-prs", REAL_FIXTURE),
        "utf8",
      ),
    ) as { pr: Record<string, unknown> };
    real.pr.additions = 3e9;
    real.pr.deletions = 3e9;
    real.pr.changed_files = 3e9;

    const dir = await mkdtemp(join(tmpdir(), "aop-prnum-"));
    const file = join(dir, "f1.json");
    await writeFile(file, JSON.stringify(real), "utf8");
    const report = await validateFixture(file);
    const numericComplaints = report.findings.filter((f) =>
      /additions|deletions|changed_files/.test(f.code),
    );
    expect(numericComplaints).toEqual([]);
  });

  it("while pr.number past INTEGER's max is the one the store refuses", async () => {
    // The pair: same magnitude, different destination, different answer. That
    // asymmetry IS the finding, so it is asserted side by side rather than in
    // two files.
    const store = new MemoryStore();
    await expect(store.writeRun(run(3e9) as never)).rejects.toThrow();
  });
});
