import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolError, type Tool, type ToolContext } from "./types.js";

const inputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
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

function fixturePath(fixturesDir: string, owner: string, repo: string, ref: string): string {
  const slug = `${owner}__${repo}__${ref}`.replace(/[\\/]/g, "_");
  return path.resolve(fixturesDir, "..", CHECKS_SUBDIR, `${slug}.json`);
}

export const runCheckTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: "run_check",
  description:
    "Query CI status for a ref. In replay mode, reads from fixtures/checks/<owner>__<repo>__<ref>.json " +
    "and (if checkName is provided) filters to that one entry. Live-mode GitHub Checks API is stubbed.",
  inputSchema,
  outputSchema,
  async run(input, ctx: ToolContext) {
    if (ctx.mode !== "replay") {
      throw new ToolError(
        "run_check",
        "unsupported_in_replay",
        "live mode is stubbed until the planner (#3) wires the GitHub client",
      );
    }
    const candidate = fixturePath(ctx.fixturesDir, input.owner, input.repo, input.ref);
    let raw: string;
    try {
      raw = await readFile(candidate, "utf8");
    } catch {
      return {
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        source: "missing_fixture" as const,
        checks: [],
      };
    }
    const parsed = fixtureSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new ToolError("run_check", "internal", `checks fixture at ${candidate} failed schema: ${parsed.error.message}`);
    }
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
