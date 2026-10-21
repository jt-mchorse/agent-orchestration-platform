import path from "node:path";
import { z } from "zod";
import { fixtureKeyPart, readExactFixture } from "./fixture-key.js";
import { ToolError, type Tool, type ToolContext } from "./types.js";

// owner, repo and ref name the checks fixture file (#207, #213).
const inputSchema = z.object({
  owner: fixtureKeyPart,
  repo: fixtureKeyPart,
  ref: fixtureKeyPart,
  checkName: z.string().min(1).optional(),
});

const checkSchema = z.object({
  name: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"])
    .nullable(),
  detailsUrl: z.string().nullable(),
});

const outputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string(),
  source: z.enum(["fixture", "missing_fixture"]),
  checks: z.array(checkSchema),
});

const fixtureSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string(),
  checks: z.array(checkSchema),
});

const CHECKS_SUBDIR = "checks";

/**
 * The checks fixture file name for one `(owner, repo, ref)` (#207).
 *
 * Injective, the key `read_file_at_ref` adopted in #201: each component is
 * percent-encoded and the components are joined by `+`, which
 * `encodeURIComponent` always escapes, so no component can contain the
 * separator and none can contain a path separator. The old name joined with
 * `__` and mapped `/` and `\` to `_`, so `feature/x` and `feature_x` were one
 * file: the two could not both be recorded, and a lookup for the unrecorded
 * one read the other's fixture and failed the coordinate check below as
 * `internal` instead of returning `missing_fixture`.
 */
export function checksFixtureFile(owner: string, repo: string, ref: string): string {
  return `${[owner, repo, ref].map(encodeURIComponent).join("+")}.json`;
}

function checksDir(fixturesDir: string): string {
  return path.resolve(fixturesDir, "..", CHECKS_SUBDIR);
}

export const runCheckTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: "run_check",
  description:
    "Query CI status for a ref. In replay mode, reads from fixtures/checks/ (one file per input, named " +
    "owner+repo+ref with each part percent-encoded, plus .json) " +
    "and (if checkName is provided) filters to that one entry. Live-mode GitHub Checks API is stubbed.",
  inputSchema,
  outputSchema,
  async run(input, ctx: ToolContext) {
    if (ctx.mode !== "replay") {
      throw new ToolError(
        "run_check",
        "unsupported_in_live",
        "live mode is stubbed until the planner (#3) wires the GitHub client",
      );
    }
    const dir = checksDir(ctx.fixturesDir);
    const name = checksFixtureFile(input.owner, input.repo, input.ref);
    const candidate = path.join(dir, name);
    // Exact-name read (#249): on a case-insensitive filesystem a plain
    // `readFile` of `release/v1`'s name opened `release/V1`'s fixture, which
    // then failed the coordinate check below as `internal`. A fixture recorded
    // only under a case-folded name is a missing fixture.
    const raw = await readExactFixture(dir, name);
    if (raw === null) {
      return {
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        source: "missing_fixture" as const,
        checks: [],
      };
    }
    // Decode under guard. `safeParse` only catches Zod mismatches, not a
    // `JSON.parse` SyntaxError, so a corrupt fixture at the deterministic
    // checks path threw a raw SyntaxError — and `executor.ts` re-raises any
    // non-`ToolError` as a run crash (it only catches `ToolError` as a per-step
    // error outcome). That poisoned the whole run on one bad fixture (#79, the
    // single-path twin of the #73/#77 directory-walk bugs). Map the SyntaxError
    // to the SAME `internal` ToolError the schema-mismatch path below raises:
    // `readFile` already succeeded, so the file exists and only its *content* is
    // corrupt — the corrupt-fixture case, categorically distinct from the
    // read-failure → `missing_fixture` path above (which means "no fixture at
    // all"). A truncated/corrupt recording must surface, not masquerade as
    // "this ref has no checks".
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ToolError("run_check", "internal", `checks fixture at ${candidate} is not valid JSON: ${detail}`);
    }
    const parsed = fixtureSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new ToolError("run_check", "internal", `checks fixture at ${candidate} failed schema: ${parsed.error.message}`);
    }
    // Past the exact-name read the file is this input's own fixture (the name
    // is injective), so a coordinate mismatch is a mis-recorded fixture, the
    // same corrupt-content case as the two checks above, and stays `internal`.
    // A case-folded name never reaches here: it is `missing_fixture` (#249).
    if (parsed.data.owner !== input.owner || parsed.data.repo !== input.repo || parsed.data.ref !== input.ref) {
      throw new ToolError(
        "run_check",
        "internal",
        `checks fixture coordinates do not match input (${parsed.data.owner}/${parsed.data.repo}@${parsed.data.ref} vs ${input.owner}/${input.repo}@${input.ref})`,
      );
    }
    const filtered = input.checkName
      ? parsed.data.checks.filter((c) => c.name === input.checkName)
      : parsed.data.checks;
    return {
      owner: input.owner,
      repo: input.repo,
      ref: input.ref,
      source: "fixture" as const,
      checks: filtered,
    };
  },
};
