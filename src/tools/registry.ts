import type { ZodTypeAny, z } from "zod";
import { type AnyTool, type Tool, type ToolContext, ToolError } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register<I extends ZodTypeAny, O extends ZodTypeAny>(tool: Tool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as AnyTool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AnyTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }
    return tool;
  }

  list(): { name: string; description: string }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description }));
  }

  async invoke(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.get(name);
    const parsedInput = tool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ToolError(name, "input_validation", parsedInput.error.message);
    }
    const output = await tool.run(parsedInput.data as z.infer<typeof tool.inputSchema>, ctx);
    const parsedOutput = tool.outputSchema.safeParse(output);
    if (!parsedOutput.success) {
      throw new ToolError(name, "output_validation", parsedOutput.error.message);
    }
    return parsedOutput.data;
  }
}
