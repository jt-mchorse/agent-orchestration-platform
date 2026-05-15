export { ToolRegistry } from "./tools/registry.js";
export { ToolError, type Tool, type ToolContext, type ToolMode, type AnyTool } from "./tools/types.js";
export { fetchPrTool } from "./tools/fetch-pr.js";
export { readFileAtRefTool } from "./tools/read-file-at-ref.js";
export { searchRepoTool } from "./tools/search-repo.js";
export { runCheckTool } from "./tools/run-check.js";

import { ToolRegistry } from "./tools/registry.js";
import { fetchPrTool } from "./tools/fetch-pr.js";
import { readFileAtRefTool } from "./tools/read-file-at-ref.js";
import { searchRepoTool } from "./tools/search-repo.js";
import { runCheckTool } from "./tools/run-check.js";

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fetchPrTool);
  registry.register(readFileAtRefTool);
  registry.register(searchRepoTool);
  registry.register(runCheckTool);
  return registry;
}
