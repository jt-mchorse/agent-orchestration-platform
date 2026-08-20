/**
 * No tracked source file carries a raw control byte (#120 follow-up).
 *
 * The tie-break key added for #120 needed a separator that does not occur in
 * finding prose, and U+0000 was the natural pick. It was first committed as a
 * *literal* NUL byte inside the template literal. That is valid TypeScript and
 * every one of the repo's 392 tests passed on it — but git classifies any blob
 * with a NUL in its first 8000 bytes as BINARY, so `src/eval/score.ts` landed
 * on the PR as `Binary files a/... and b/... differ`:
 *
 *   - no reviewable diff, on the one file whose ordering semantics were the
 *     entire point of the change,
 *   - no `git blame`,
 *   - no three-way merge — a conflict on that file could only be resolved by
 *     picking a whole side.
 *
 * Nothing in typecheck, lint or the test suite can see this: the *string* is
 * identical whether the source spells it as a raw byte or as the escape
 * `\u0000`. Only the on-disk encoding of the source differs. So the check has
 * to be on the source bytes, which is what this test does.
 *
 * Scope: the byte classes git's own binary heuristic reacts to. Ordinary text
 * control characters (tab, LF, CR) are excluded; everything else below 0x20,
 * plus DEL, is rejected. Write such a character as an escape sequence instead
 * — `\u0000`, `\u001b` — which is textually identical to the compiler and
 * keeps the file diffable.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(here, "..");

/** Tab, LF and CR are legitimate in text; everything else < 0x20 and DEL is not. */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|sql|sh|py|txt)$/;

function trackedSourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((p) => p.length > 0)
    .filter((p) => SOURCE_EXT.test(p));
}

function rawControlBytes(rel: string): Array<{ offset: number; byte: number }> {
  const buf = readFileSync(resolve(ROOT, rel));
  const hits: Array<{ offset: number; byte: number }> = [];
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i] as number;
    if ((b < 0x20 && !ALLOWED_CONTROL.has(b)) || b === 0x7f) {
      hits.push({ offset: i, byte: b });
    }
  }
  return hits;
}

describe("no raw control bytes in tracked source (#120 follow-up)", () => {
  it("finds source files to check", () => {
    // Guards the guard: a glob or `git ls-files` change that silently matched
    // nothing would make every assertion below vacuously true.
    expect(trackedSourceFiles().length).toBeGreaterThan(20);
  });

  it("src/eval/score.ts spells the tie-break separator as an escape", () => {
    const raw = readFileSync(resolve(ROOT, "src/eval/score.ts"));
    expect(
      raw.includes(0x00),
      "src/eval/score.ts contains a literal NUL byte. Git will treat the file " +
        "as binary and the tie-break change becomes undiffable. Write the " +
        "separator as the escape \\u0000 instead — the string value is the same.",
    ).toBe(false);
    expect(raw.toString("utf8")).toContain("${actual.severity}\\u0000${actual.message}");
  });

  it("no tracked source file contains a raw control byte", () => {
    const offenders = trackedSourceFiles()
      .map((rel) => ({ rel, hits: rawControlBytes(rel) }))
      .filter((r) => r.hits.length > 0)
      .map(
        (r) =>
          `${r.rel}: ${r.hits.length} byte(s), first ` +
          `0x${(r.hits[0] as { byte: number }).byte.toString(16).padStart(2, "0")} ` +
          `at offset ${(r.hits[0] as { offset: number }).offset}`,
      );
    expect(
      offenders,
      "These tracked files carry raw control bytes. Git may classify them as " +
        "binary, which costs diff, blame and three-way merge on them. Replace " +
        "each byte with an escape sequence in the source.",
    ).toEqual([]);
  });
});
