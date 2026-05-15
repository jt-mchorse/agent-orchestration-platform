# portfolio-context

A small Model Context Protocol (MCP) server that exposes a portfolio repo's
recorded **core decisions** so an agent can flag PRs that conflict with
non-superseded decisions before approving them.

The PR-review agent in this repo consumes it as the fifth tool in its
registry (`get_portfolio_context`). The server is also runnable on its own
as a standard stdio MCP server — you can wire it into Claude Desktop or any
other MCP-aware client the same way.

## Exposed tools

| Tool | Input | Output |
|------|-------|--------|
| `get_repo_core_decisions` | `{ repo: string }` | `{ repo, source, decisions[] }` — see `decisions.ts` for the `CoreDecision` shape. |

## Configuration

The server reads one environment variable:

| Var | Required | Meaning |
|-----|----------|---------|
| `PORTFOLIO_ROOT` | yes | Absolute path to the portfolio checkout root. The server resolves `repos/<slug>/MEMORY/core_decisions_ai.md` under it (and `portfolio-ops/MEMORY/...` for the meta repo). |

## Running standalone

```bash
npm run build
PORTFOLIO_ROOT=/path/to/portfolio node dist/mcp-server/portfolio-context/bin.js
```

The `bin` field in `package.json` also exposes it as
`portfolio-context-mcp` after install.

## Wiring into Claude Desktop

```json
{
  "mcpServers": {
    "portfolio-context": {
      "command": "node",
      "args": ["/abs/path/to/agent-orchestration-platform/dist/mcp-server/portfolio-context/bin.js"],
      "env": { "PORTFOLIO_ROOT": "/abs/path/to/portfolio" }
    }
  }
}
```

## Security notes

- The repo slug is validated against `[A-Za-z0-9_.\\-]` before being joined
  to `PORTFOLIO_ROOT`, so requests cannot escape the configured root.
- The server only reads files; it does not write, spawn, or network.

## In-process embedding

The agent's `get_portfolio_context` tool embeds this server in-process via
`InMemoryTransport` (see `src/tools/get-portfolio-context.ts`). The protocol
exchange is the same — only the transport differs. Tests exercise the
in-process path.
