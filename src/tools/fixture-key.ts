import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * In `u` mode a well-formed surrogate PAIR is one astral code point, so
 * `\p{Cs}` matches only a lone half (the same test as `isStorableRunId`).
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * A tool input that becomes part of a replay fixture's file name (#213).
 *
 * `read_file_at_ref` names its cache file by `encodeURIComponent`-ing each
 * input component (#201), and that function throws `URIError` on a lone
 * surrogate, where the old `replace(/[\\/]/g, "_")` key could not throw. The
 * schema was `z.string().min(1)`, which accepts one, so the tool threw a plain
 * `URIError`, the executor re-raised it as a programmer bug, and the whole run
 * aborted before `finalize()`. No git ref, path, owner or repo can hold a lone
 * surrogate (they are UTF-8 bytes), so such an input can never name a fixture:
 * it is refused here, which the registry reports as `input_validation`, an
 * observation the planner can replan around.
 */
export const fixtureKeyPart = z
  .string()
  .min(1)
  .refine((s) => !LONE_SURROGATE.test(s), {
    message: "must not contain a lone surrogate (no git ref, path, owner or repo can)",
  });

/**
 * Read the replay fixture named exactly `name` in `dir`, or `null` (#249).
 *
 * The fixture names are distinct strings, but on a case-insensitive
 * filesystem (macOS APFS by default, Windows) `README.md` and `readme.md`
 * name one file, while git paths and refs are case-sensitive. A plain
 * `readFile` of the unrecorded input's name opened the recorded one:
 * `read_file_at_ref` served `README.md`'s content labelled `file_cache` for
 * `readme.md`, and `run_check` failed its coordinate check as `internal` for
 * `release/v1` against a recorded `release/V1`. The directory listing carries
 * each name as it was written, so the fixture is read only when that exact
 * name is there; a case-folded match is a missing fixture.
 */
export async function readExactFixture(dir: string, name: string): Promise<string | null> {
  try {
    const entries = await readdir(dir);
    if (!entries.includes(name)) return null;
    return await readFile(path.join(dir, name), "utf8");
  } catch {
    return null;
  }
}
