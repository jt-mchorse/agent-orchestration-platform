#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPortfolioContextServer } from "./server.js";

async function main(): Promise<void> {
  const portfolioRoot = process.env["PORTFOLIO_ROOT"];
  if (!portfolioRoot || portfolioRoot.length === 0) {
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
