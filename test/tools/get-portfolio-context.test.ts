import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPortfolioContextServer } from "../../mcp-server/portfolio-context/server.js";
import { createGetPortfolioContextTool } from "../../src/tools/get-portfolio-context.js";
import type { ToolContext } from "../../src/tools/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.resolve(here, "../../.tmp-get-portfolio-context-tool");
const repo = "agent-orchestration-platform";
const memoryDir = path.join(tmpRoot, "repos", repo, "MEMORY");

const SAMPLE = `- id: D-001
  date: 2026-05-10
  decision: scope_per_portfolio_handoff_section_2
  rationale: locked_scope_prevents_drift
  alternatives_rejected: []
  reversibility: expensive
  related_issues: []
  superseded_by: null

- id: D-002
  date: 2026-05-15
  decision: agent_use_case_is_pr_review_not_research_brief
  rationale: real_input_corpus_exists
  alternatives_rejected: [research_brief_agent_softer_inputs_and_outputs]
  reversibility: expensive
  related_issues: [#1, #2, #3]
  superseded_by: null
`;

function inMemoryConnect() {
  return async () => {
    const server = createPortfolioContextServer({ portfolioRoot: tmpRoot });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      client,
      cleanup: async () => {
        await client.close();
        await server.close();
      },
    };
  };
}

const ctx: ToolContext = { mode: "replay", fixturesDir: tmpRoot };

describe("get_portfolio_context tool", () => {
  beforeAll(async () => {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, "core_decisions_ai.md"), SAMPLE, "utf8");
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns parsed decisions for the requested repo via the MCP server", async () => {
    const tool = createGetPortfolioContextTool(inMemoryConnect());
    const result = await tool.run({ repo }, ctx);
    expect(result.repo).toBe(repo);
    expect(result.decisions.map((d) => d.id)).toEqual(["D-001", "D-002"]);
    expect(result.decisions[1]?.alternatives_rejected).toEqual([
      "research_brief_agent_softer_inputs_and_outputs",
    ]);
    expect(result.decisions[1]?.related_issues).toEqual(["#1", "#2", "#3"]);
  });

  it("surfaces a ToolError when the MCP call returns isError", async () => {
    const tool = createGetPortfolioContextTool(inMemoryConnect());
    await expect(tool.run({ repo: "no-such-repo" }, ctx)).rejects.toThrow(
      /failed to read core decisions/,
    );
  });

  it("rejects malformed input at the schema layer", () => {
    const tool = createGetPortfolioContextTool(inMemoryConnect());
    const parsed = tool.inputSchema.safeParse({ repo: "" });
    expect(parsed.success).toBe(false);
  });
});
