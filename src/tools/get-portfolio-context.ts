import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createPortfolioContextServer } from "../../mcp-server/portfolio-context/server.js";
import { ToolError, type Tool, type ToolContext } from "./types.js";

const inputSchema = z.object({
  repo: z.string().min(1),
});

const decisionSchema = z.object({
  id: z.string(),
  date: z.string().nullable(),
  decision: z.string().nullable(),
  rationale: z.string().nullable(),
  alternatives_rejected: z.array(z.string()),
  reversibility: z.enum(["cheap", "expensive", "one-way", "unknown"]),
  related_issues: z.array(z.string()),
  superseded_by: z.string().nullable(),
});

const outputSchema = z.object({
  repo: z.string(),
  source: z.string(),
  decisions: z.array(decisionSchema),
});

export type GetPortfolioContextConnect = () => Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}>;

async function defaultConnect(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const portfolioRoot = process.env["PORTFOLIO_ROOT"];
  if (!portfolioRoot || portfolioRoot.length === 0) {
    throw new ToolError(
      "get_portfolio_context",
      "internal",
      "PORTFOLIO_ROOT environment variable must be set to the portfolio checkout root before invoking get_portfolio_context",
    );
  }
  const server = createPortfolioContextServer({ portfolioRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "agent-orchestration-platform", version: "0.1.0" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function createGetPortfolioContextTool(
  connect: GetPortfolioContextConnect = defaultConnect,
): Tool<typeof inputSchema, typeof outputSchema> {
  return {
    name: "get_portfolio_context",
    description:
      "Returns the parsed list of core decisions for a portfolio repo by calling the local " +
      "portfolio-context MCP server (tool: get_repo_core_decisions). Use to flag PRs that conflict " +
      "with non-superseded decisions before approving. Requires PORTFOLIO_ROOT in the environment.",
    inputSchema,
    outputSchema,
    async run(input, _ctx: ToolContext) {
      const { client, cleanup } = await connect();
      try {
        const result = await client.callTool({
          name: "get_repo_core_decisions",
          arguments: { repo: input.repo },
        });
        if (result.isError) {
          const text =
            Array.isArray(result.content) && result.content[0]?.type === "text"
              ? result.content[0].text
              : "mcp tool returned an error";
          throw new ToolError("get_portfolio_context", "internal", String(text));
        }
        const structured = result.structuredContent ?? extractJsonContent(result.content);
        const parsed = outputSchema.safeParse(structured);
        if (!parsed.success) {
          throw new ToolError(
            "get_portfolio_context",
            "output_validation",
            `mcp response did not match expected shape: ${parsed.error.message}`,
          );
        }
        return parsed.data;
      } finally {
        await cleanup();
      }
    },
  };
}

function extractJsonContent(content: unknown): unknown {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export const getPortfolioContextTool = createGetPortfolioContextTool();
