import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError } from "../src/tools/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool, ToolContext } from "../src/tools/types.js";

const echoInput = z.object({ text: z.string().min(1) });
const echoOutput = z.object({ echoed: z.string() });

const echoTool: Tool<typeof echoInput, typeof echoOutput> = {
  name: "echo",
  description: "echo input.text",
  inputSchema: echoInput,
  outputSchema: echoOutput,
  async run(input) {
    return { echoed: input.text };
  },
};

const ctx: ToolContext = { mode: "replay", fixturesDir: "fixtures/sample-prs" };

describe("ToolRegistry", () => {
  it("registers, lists, and invokes tools", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);

    expect(reg.has("echo")).toBe(true);
    expect(reg.list()).toEqual([
      { name: "echo", description: "echo input.text", destructive: false },
    ]);

    const result = await reg.invoke("echo", { text: "hello" }, ctx);
    expect(result).toEqual({ echoed: "hello" });
  });

  it("rejects duplicate registration", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(() => reg.register(echoTool)).toThrow(/already registered/);
  });

  it("throws on invocation of unknown tool", async () => {
    const reg = new ToolRegistry();
    await expect(reg.invoke("nope", {}, ctx)).rejects.toThrow(/unknown tool/);
  });

  it("validates input against the tool's input schema", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    await expect(reg.invoke("echo", { text: "" }, ctx)).rejects.toBeInstanceOf(ToolError);
  });

  it("validates output against the tool's output schema", async () => {
    const reg = new ToolRegistry();
    const badInput = z.object({ text: z.string() });
    const badOutput = z.object({ count: z.number() });
    const badTool: Tool<typeof badInput, typeof badOutput> = {
      name: "bad",
      description: "returns wrong shape",
      inputSchema: badInput,
      outputSchema: badOutput,
      async run(input) {
        return { count: input.text } as unknown as { count: number };
      },
    };
    reg.register(badTool);
    await expect(reg.invoke("bad", { text: "x" }, ctx)).rejects.toBeInstanceOf(ToolError);
  });
});
