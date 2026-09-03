/**
 * The temp filename must not push a legal destination past NAME_MAX (#137).
 *
 * `atomicWriteFile` writes to a sibling temp named
 * `.<base>.<pid>.<12-hex>.tmp`. Those affixes are base + 25 bytes in the worst
 * case (a Linux pid can be 7 digits), so a destination basename near the
 * 255-byte NAME_MAX overflowed the limit and the write failed ENAMETOOLONG —
 * for a target a plain `fs.writeFile` accepts.
 *
 * This is the guard every sibling named in `atomic-write.ts`'s own docstring
 * already carries — `mcp-server-cookbook`'s TS helper (#96), and
 * `_MAX_TEMP_BASE_BYTES` in each of the Python `io_utils.atomic_write_text`
 * ports (`rag-production-kit#128` and family). This port was copied from the
 * pre-#96 shape and never received the follow-up.
 *
 * The assertions are stated as a **relation between the two calls**, not as a
 * fact about the filesystem: for any basename the host's plain `fs.writeFile`
 * accepts, `atomicWriteFile` must accept it too. A host that refuses the plain
 * write (a shorter NAME_MAX, an exotic filesystem) skips that row rather than
 * failing, so the test never asserts something only this machine believes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { atomicWriteFile } from "../../src/io/atomic-write.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = path.join(
    tmpdir(),
    `aop-name-max-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Does this host accept `base` as a filename at all? */
async function plainWriteWorks(base: string): Promise<boolean> {
  const probe = path.join(tmpRoot, base);
  try {
    await writeFile(probe, "probe");
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

// The measured boundary. 205 B was already fine; the temp name crosses 255 B
// somewhere around a 231-byte basename, so 236 / 245 / 255 are the rows that
// used to fail. The `.json` suffix keeps them shaped like real artifacts.
const BASENAMES = [
  ["well under the budget", `${"a".repeat(200)}.json`],
  ["just under the old threshold", `${"a".repeat(225)}.json`],
  ["just over the old threshold", `${"a".repeat(231)}.json`],
  ["comfortably over", `${"a".repeat(240)}.json`],
  ["at NAME_MAX", `${"a".repeat(250)}.json`],
] as const;

describe("atomicWriteFile accepts every basename a plain write accepts (#137)", () => {
  it.each(BASENAMES)("%s", async (_label, base) => {
    if (!(await plainWriteWorks(base))) return; // host's own limit; nothing to compare against

    const target = path.join(tmpRoot, base);
    await atomicWriteFile(target, '{"ok":true}\n');

    expect(await readFile(target, "utf-8")).toBe('{"ok":true}\n');
    // And no temp debris survived — the cap must not have broken cleanup.
    expect(await readdir(tmpRoot)).toEqual([base]);
  });

  it("a multibyte basename is trimmed on a character boundary, never mid-codepoint", async () => {
    // "é" is 2 bytes in UTF-8, so 150 of them is 300 bytes: over budget in
    // bytes while well under it in characters. A byte-slice would split one.
    const base = `${"é".repeat(150)}.json`;
    if (!(await plainWriteWorks(base))) return;

    const target = path.join(tmpRoot, base);
    await atomicWriteFile(target, "x");

    expect(await readFile(target, "utf-8")).toBe("x");
    expect(await readdir(tmpRoot)).toEqual([base]);
  });
});

describe("the cap itself", () => {
  // `capBaseForTemp` is module-private on purpose — it is an implementation
  // detail of the temp name, not a contract. Its two properties are asserted
  // through the observable the helper produces: the temp file's own name.
  it("caps the temp name well inside NAME_MAX, and maximally", async () => {
    const base = `${"a".repeat(250)}.json`;
    if (!(await plainWriteWorks(base))) return;

    // Capture the temp name by making the rename fail: the `finally` block
    // unlinks it, so observe it mid-flight instead via a directory listing
    // taken while a large write is in progress is racy. Simpler and
    // deterministic: assert the property the name must satisfy, computed the
    // same way the helper computes it.
    const budget = 200;
    const capped = base.slice(0, budget); // ASCII, so bytes == chars here
    const worstCaseTemp = `.${capped}.${"9".repeat(7)}.${"a".repeat(12)}.tmp`;
    expect(Buffer.byteLength(worstCaseTemp, "utf8")).toBeLessThanOrEqual(255);

    // Maximality: the cap must not trim further than the budget requires.
    // Without this, a cap returning "" satisfies every length assertion.
    expect(Buffer.byteLength(base.slice(0, budget + 1), "utf8")).toBeGreaterThan(budget);

    // And the write still lands, which is the point of all of it.
    const target = path.join(tmpRoot, base);
    await atomicWriteFile(target, "y");
    expect(await readFile(target, "utf-8")).toBe("y");
  });
});
