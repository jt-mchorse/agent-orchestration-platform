import type { ZodTypeAny, z } from "zod";
import { type AnyTool, type Tool, type ToolContext, ToolError } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register<I extends ZodTypeAny, O extends ZodTypeAny>(tool: Tool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    if (tool.annotations?.destructive && !tool.annotations.destructiveReason) {
      throw new Error(
        `tool ${tool.name} is marked destructive but has no destructiveReason — required so the approval prompt can describe the effect`,
      );
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

  list(): {
    name: string;
    description: string;
    destructive: boolean;
    destructiveReason: string | null;
  }[] {
    // `destructiveReason` is enforced non-null at register() for destructive
    // tools (see line 11–14 above), so the non-null-assertion below is safe.
    // Non-destructive tools get `null` rather than the invoke-time
    // `"tool is marked destructive"` fallback — `list()` describes the
    // tool's intent, not how the invoke path renders missing reasons.
    return [...this.tools.values()].map((t) => {
      const isDestructive = t.annotations?.destructive === true;
      return {
        name: t.name,
        description: t.description,
        destructive: isDestructive,
        destructiveReason: isDestructive
          ? (t.annotations?.destructiveReason ?? null)
          : null,
      };
    });
  }

  async invoke(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.get(name);
    const parsedInput = tool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ToolError(name, "input_validation", parsedInput.error.message);
    }
    if (tool.annotations?.destructive) {
      const reason = tool.annotations.destructiveReason ?? "tool is marked destructive";
      if (!ctx.approvals) {
        throw new ToolError(
          name,
          "approval_missing",
          `destructive tool requires an approvals provider on ToolContext (effect: ${reason})`,
        );
      }
      const decision = await ctx.approvals.requestApproval({
        toolName: name,
        input: parsedInput.data,
        reason,
      });
      if (!decision.approved) {
        throw new ToolError(
          name,
          "approval_denied",
          `approval denied${decision.reason ? `: ${decision.reason}` : ""}`,
        );
      }
    }
    const output = await tool.run(parsedInput.data as z.infer<typeof tool.inputSchema>, ctx);
    const parsedOutput = tool.outputSchema.safeParse(output);
    if (!parsedOutput.success) {
      throw new ToolError(name, "output_validation", parsedOutput.error.message);
    }
    return parsedOutput.data;
  }
}
