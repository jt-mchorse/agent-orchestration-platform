import { z } from "zod";
import { ToolError, type Tool, type ToolContext } from "./types.js";

// The canonical `Finding` (src/agent/types.ts) as-is: the anchor is optional
// and the line range is a `[start, end]` pair. The schema used to demand
// `file` plus `line_start`/`line_end`, a shape nothing in the pipeline
// produces, so every Review with a finding -- including both committed
// goldens -- failed input validation and only an empty Review could be posted
// (#292, the other half of #63). Strict, so a caller still passing the old
// `line_start`/`line_end` keys is refused instead of having its anchor
// silently stripped. Exported so `validateGolden` (src/eval/validate.ts)
// checks each golden finding against this same schema (#294).
export const findingSchema = z
  .object({
    severity: z.enum(["blocker", "concern", "nit", "praise"]),
    file: z.string().min(1).optional(),
    lineRange: z
      .tuple([z.number().int().min(1), z.number().int().min(1)])
      .refine(([start, end]) => start <= end, { message: "lineRange start must be <= end" })
      .optional(),
    message: z.string().min(1),
  })
  .strict();

type PostedFinding = z.infer<typeof findingSchema>;

/** `file:start-end`, `file`, `lines start-end`, or "" for an unanchored finding. */
function findingAnchor(f: PostedFinding): string {
  const range = f.lineRange ? `${f.lineRange[0]}-${f.lineRange[1]}` : undefined;
  if (f.file !== undefined) return range ? `${f.file}:${range}` : f.file;
  return range ? `lines ${range}` : "";
}

const inputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
  // Underscored to match the canonical Review["recommendation"] (src/agent/types.ts)
  // and every other producer/consumer (planner, eval runner/validator, UI CSS).
  // A space-separated enum here rejected the synthesized Review this HITL tool
  // is meant to post (#63).
  recommendation: z.enum(["request_changes", "approve_with_comments", "approve"]),
});

const outputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  posted: z.boolean(),
  mode: z.enum(["replay", "live"]),
  preview: z.string(),
});

// Exported so the CLI approval prompt shows the operator this exact rendering
// -- the comment they are approving -- instead of the raw tool input (#250).
export function renderPreview(input: z.infer<typeof inputSchema>): string {
  const lines: string[] = [];
  lines.push(`# Review: ${input.owner}/${input.repo}#${input.number}`);
  lines.push("");
  lines.push(input.summary);
  if (input.findings.length > 0) {
    lines.push("");
    lines.push("## Findings");
    for (const f of input.findings) {
      const anchor = findingAnchor(f);
      const where = anchor ? ` \`${anchor}\`` : "";
      lines.push(`- **${f.severity.toUpperCase()}**${where} — ${f.message}`);
    }
  }
  lines.push("");
  lines.push(`**Recommendation:** ${input.recommendation}`);
  return lines.join("\n");
}

export const postReviewCommentTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: "post_review_comment",
  description:
    "Post a single structured review comment on a PR. In replay mode, renders the comment to a " +
    "preview string and reports posted=false. In live mode (not yet wired), would call the GitHub " +
    "API. Marked destructive: every invocation routes through the approval provider on ToolContext.",
  inputSchema,
  outputSchema,
  annotations: {
    destructive: true,
    destructiveReason: "post a public review comment on someone else's PR",
  },
  async run(input, ctx: ToolContext) {
    const preview = renderPreview(input);
    if (ctx.mode === "replay") {
      return {
        owner: input.owner,
        repo: input.repo,
        number: input.number,
        posted: false,
        mode: "replay" as const,
        preview,
      };
    }
    throw new ToolError(
      "post_review_comment",
      "unsupported_in_live",
      "live mode is stubbed until the planner (#3) wires the GitHub client; the destructive flag is real and tested via the approval flow",
    );
  },
};
