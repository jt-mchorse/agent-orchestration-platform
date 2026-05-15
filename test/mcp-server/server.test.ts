import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPortfolioContextServer } from "../../mcp-server/portfolio-context/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.resolve(here, "../../.tmp-portfolio-context-server");
const repo = "rag-production-kit";
const memoryDir = path.join(tmpRoot, "repos", repo, "MEMORY");

const SAMPLE = `- id: D-001
  date: 2026-05-10
  decision: scope_locked
  rationale: locked_scope_prevents_drift
  alternatives_rejected: []
  reversibility: expensive
  related_issues: []
  superseded_by: null
`;

interface ToolCallResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}

async function connect(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createPortfolioContextServer({ portfolioRoot: tmpRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("portfolio-context MCP server", () => {
  beforeAll(async () => {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, "core_decisions_ai.md"), SAMPLE, "utf8");
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("exposes get_repo_core_decisions in the listed tools", async () => {
    const { client, cleanup } = await connect();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("get_repo_core_decisions");
    } finally {
      await cleanup();
    }
  });

  it("returns parsed decisions in structuredContent when called with a real repo", async () => {
    const { client, cleanup } = await connect();
    try {
      const result = (await client.callTool({
        name: "get_repo_core_decisions",
        arguments: { repo },
      })) as ToolCallResult;
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        repo: string;
        decisions: Array<{ id: string; reversibility: string }>;
      };
      expect(structured.repo).toBe(repo);
      expect(structured.decisions).toHaveLength(1);
      expect(structured.decisions[0]?.id).toBe("D-001");
      expect(structured.decisions[0]?.reversibility).toBe("expensive");
    } finally {
      await cleanup();
    }
  });

  it("returns isError with a readable message when the repo's MEMORY file is missing", async () => {
    const { client, cleanup } = await connect();
    try {
      const result = (await client.callTool({
        name: "get_repo_core_decisions",
        arguments: { repo: "no-such-repo" },
      })) as ToolCallResult;
      expect(result.isError).toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      const first = (result.content as Array<{ type: string; text?: string }>)[0];
      expect(first?.type).toBe("text");
      expect(first?.text).toMatch(/failed to read core decisions for no-such-repo/);
    } finally {
      await cleanup();
    }
  });

  it("rejects repo names that try to escape the portfolio root", async () => {
    const { client, cleanup } = await connect();
    try {
      const result = (await client.callTool({
        name: "get_repo_core_decisions",
        arguments: { repo: "../etc" },
      })) as ToolCallResult;
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
