import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolError, type Tool, type ToolContext } from "./types.js";

const inputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(50).default(20),
});

const matchSchema = z.object({
  filename: z.string(),
  lineHint: z.string(),
});

const outputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  query: z.string(),
  source: z.enum(["fixture_substring"]),
  matches: z.array(matchSchema),
  truncated: z.boolean(),
});

const fixtureLiteSchema = z.object({
  repo: z.string(),
  files: z.array(
    z.object({
      filename: z.string(),
      patch: z.string().nullable(),
    }),
  ),
});

function firstMatchingLine(patch: string | null, needle: string): string | null {
  if (!patch) return null;
  const lower = needle.toLowerCase();
  for (const raw of patch.split("\n")) {
    if (raw.toLowerCase().includes(lower)) {
      return raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
    }
  }
  return null;
}

export const searchRepoTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: "search_repo",
  description:
    "Substring search across the files in committed PR fixtures for (owner, repo). " +
    "Returns up to maxResults `{filename, lineHint}` entries. Live-mode GitHub code search is stubbed.",
  inputSchema,
  outputSchema,
  async run(input, ctx: ToolContext) {
    if (ctx.mode !== "replay") {
      throw new ToolError(
        "search_repo",
        "unsupported_in_live",
        "live mode is stubbed until the planner (#3) wires the GitHub client",
      );
    }
    const targetRepo = `${input.owner}/${input.repo}`;
    const entries = await readdir(ctx.fixturesDir);
    const matches: { filename: string; lineHint: string }[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const full = path.join(ctx.fixturesDir, entry);
      const raw = await readFile(full, "utf8");
      const parsed = fixtureLiteSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      if (parsed.data.repo !== targetRepo) continue;
      for (const file of parsed.data.files) {
        const pathMatch = file.filename.toLowerCase().includes(input.query.toLowerCase());
        const line = firstMatchingLine(file.patch, input.query);
        if (pathMatch && !line) {
          matches.push({ filename: file.filename, lineHint: "(filename match)" });
        } else if (line) {
          matches.push({ filename: file.filename, lineHint: line });
        }
        if (matches.length >= input.maxResults) {
          return {
            owner: input.owner,
            repo: input.repo,
            query: input.query,
            source: "fixture_substring" as const,
            matches,
            truncated: true,
          };
        }
      }
    }
    return {
      owner: input.owner,
      repo: input.repo,
      query: input.query,
      source: "fixture_substring" as const,
      matches,
      truncated: false,
    };
  },
};
