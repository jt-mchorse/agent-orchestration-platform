import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readCoreDecisions } from "./decisions.js";

export interface PortfolioContextOptions {
  portfolioRoot: string;
}

export function createPortfolioContextServer(opts: PortfolioContextOptions): McpServer {
  const server = new McpServer(
    {
      name: "portfolio-context",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.registerTool(
    "get_repo_core_decisions",
    {
      title: "Get core decisions for a portfolio repo",
      description:
        "Returns the parsed list of decisions from a portfolio repo's MEMORY/core_decisions_ai.md. " +
        "Use this to flag PRs that conflict with non-superseded decisions before approving.",
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe(
            "Portfolio repo slug (e.g. 'rag-production-kit', 'agent-orchestration-platform', or 'portfolio-ops').",
          ),
      },
    },
    async ({ repo }) => {
      try {
        const result = await readCoreDecisions(opts.portfolioRoot, repo);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `failed to read core decisions for ${repo}: ${message}`,
            },
          ],
        };
      }
    },
  );

  return server;
}
