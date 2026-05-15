import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolError, type Tool, type ToolContext } from "./types.js";

const inputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
  path: z.string().min(1),
});

const outputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string(),
  path: z.string(),
  source: z.enum(["file_cache", "patch_added"]),
  content: z.string(),
  truncated: z.boolean(),
});

const FILE_CACHE_SUBDIR = "file-cache";

function cacheKeyFile(owner: string, repo: string, ref: string, filePath: string): string {
  const slug = `${owner}__${repo}__${ref}__${filePath}`.replace(/[\\/]/g, "_");
  return `${slug}.txt`;
}

async function tryReadFromCache(
  fixturesDir: string,
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  const cacheRoot = path.resolve(fixturesDir, "..", FILE_CACHE_SUBDIR);
  const candidate = path.join(cacheRoot, cacheKeyFile(owner, repo, ref, filePath));
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return null;
  }
}

function reconstructAddedFileFromPatch(patch: string | null): string | null {
  if (!patch) return null;
  const lines = patch.split("\n");
  const added: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
  }
  return added.join("\n");
}

const fixtureFileSchema = z.object({
  filename: z.string(),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  patch: z.string().nullable(),
});
const fixtureLiteSchema = z.object({
  repo: z.string(),
  pr: z.object({ head: z.string(), base: z.string() }),
  files: z.array(fixtureFileSchema),
});

async function tryReconstructFromAnyFixture(
  fixturesDir: string,
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  const entries = await readdir(fixturesDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(fixturesDir, entry);
    const raw = await readFile(full, "utf8");
    const parsed = fixtureLiteSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    if (parsed.data.repo !== `${owner}/${repo}`) continue;
    if (parsed.data.pr.head !== ref) continue;
    const file = parsed.data.files.find((f) => f.filename === filePath);
    if (!file) continue;
    if (file.status !== "added") return null;
    return reconstructAddedFileFromPatch(file.patch);
  }
  return null;
}

export const readFileAtRefTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: "read_file_at_ref",
  description:
    "Load a file at a specific git ref. In replay mode, looks up fixtures/file-cache/ first; " +
    "falls back to reconstructing the added-side content from a fixture patch when status=added. " +
    "Returns a not_found ToolError when neither path resolves.",
  inputSchema,
  outputSchema,
  async run(input, ctx: ToolContext) {
    if (ctx.mode !== "replay") {
      throw new ToolError(
        "read_file_at_ref",
        "unsupported_in_replay",
        "live mode is stubbed until the planner (#3) wires the GitHub client",
      );
    }
    const cached = await tryReadFromCache(ctx.fixturesDir, input.owner, input.repo, input.ref, input.path);
    if (cached !== null) {
      return {
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        path: input.path,
        source: "file_cache" as const,
        content: cached,
        truncated: false,
      };
    }
    const reconstructed = await tryReconstructFromAnyFixture(
      ctx.fixturesDir,
      input.owner,
      input.repo,
      input.ref,
      input.path,
    );
    if (reconstructed !== null) {
      return {
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        path: input.path,
        source: "patch_added" as const,
        content: reconstructed,
        truncated: false,
      };
    }
    throw new ToolError(
      "read_file_at_ref",
      "not_found",
      `no cached file and no added-status fixture entry for ${input.owner}/${input.repo}@${input.ref}:${input.path}`,
    );
  },
};
