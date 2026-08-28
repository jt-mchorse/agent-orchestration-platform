#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPortfolioContextServer } from "./server.js";
import { resolvePortfolioRoot } from "../../src/io/env.js";

async function main(): Promise<void> {
  // Shared with `src/tools/get-portfolio-context.ts` (#131): one definition of
  // "set and non-blank", trimmed, so the two entry points cannot drift. Only
  // the failure *report* differs — exit 2 on stderr here, `ToolError` there.
  const portfolioRoot = resolvePortfolioRoot();
  if (portfolioRoot === undefined) {
    process.stderr.write(
      "portfolio-context: PORTFOLIO_ROOT environment variable is required (path to the portfolio checkout root).\n",
    );
    process.exit(2);
  }
  const server = createPortfolioContextServer({ portfolioRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`portfolio-context: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
