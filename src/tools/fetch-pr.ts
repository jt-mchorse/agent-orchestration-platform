import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolError, type Tool, type ToolContext } from "./types.js";

const fileSchema = z.object({
  filename: z.string(),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().nullable(),
});

const prFixtureSchema = z.object({
  schema_version: z.literal("1"),
  source: z.literal("github"),
  repo: z.string(),
  pr: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    base: z.string(),
    head: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changed_files: z.number().int().nonnegative(),
    html_url: z.string(),
    created_at: z.string(),
  }),
  files: z.array(fileSchema),
});

const inputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
});

const outputSchema = prFixtureSchema;

export type FetchPrFixture = z.infer<typeof prFixtureSchema>;

async function loadFixtureByCoordinates(
  fixturesDir: string,
  owner: string,
  repo: string,
  number: number,
): Promise<FetchPrFixture> {
  const targetRepo = `${owner}/${repo}`;
  const entries = await readdir(fixturesDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(fixturesDir, entry);
    const raw = await readFile(full, "utf8");
    const parsed = prFixtureSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    if (parsed.data.repo === targetRepo && parsed.data.pr.number === number) {
      return parsed.data;
    }
  }
  throw new ToolError(
    "fetch_pr",
    "not_found",
    `no fixture matched repo=${targetRepo} pr=${number} under ${fixturesDir}`,
  );
}

export const fetchPrTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: "fetch_pr",
  description:
    "Load a GitHub PR (metadata + per-file patches) by (owner, repo, number). " +
    "In replay mode, reads from fixtures/sample-prs/. In live mode, calls the GitHub API (not wired in this build).",
  inputSchema,
  outputSchema,
  async run(input, ctx: ToolContext) {
    if (ctx.mode === "replay") {
      return loadFixtureByCoordinates(ctx.fixturesDir, input.owner, input.repo, input.number);
    }
    throw new ToolError(
      "fetch_pr",
      "unsupported_in_replay",
      "live mode is stubbed until the planner (#3) wires the GitHub client",
    );
  },
};
