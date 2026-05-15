import type { ZodTypeAny, z } from "zod";

export type ToolMode = "replay" | "live";

export interface ToolContext {
  mode: ToolMode;
  fixturesDir: string;
}

export interface Tool<InputSchema extends ZodTypeAny, OutputSchema extends ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  run: (input: z.infer<InputSchema>, ctx: ToolContext) => Promise<z.infer<OutputSchema>>;
}

export type AnyTool = Tool<ZodTypeAny, ZodTypeAny>;

export class ToolError extends Error {
  readonly kind: "input_validation" | "output_validation" | "not_found" | "unsupported_in_replay" | "internal";
  readonly toolName: string;
  constructor(toolName: string, kind: ToolError["kind"], message: string) {
    super(`[${toolName}:${kind}] ${message}`);
    this.kind = kind;
    this.toolName = toolName;
    this.name = "ToolError";
  }
}
