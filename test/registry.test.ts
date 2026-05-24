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
      {
        name: "echo",
        description: "echo input.text",
        destructive: false,
        destructiveReason: null,
      },
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

  // ----------------------------------------------------------------
  // list() exposes destructiveReason on the self-describing surface
  // (issue #27). types.ts:46-47 documents the intent that
  // `registry.list()` stays self-describing so policy can't silently
  // drift from tool changes; this group of tests pins that.
  // ----------------------------------------------------------------

  const destructiveTool: Tool<typeof echoInput, typeof echoOutput> = {
    name: "post_review_comment",
    description: "post a comment on the PR",
    inputSchema: echoInput,
    outputSchema: echoOutput,
    annotations: {
      destructive: true,
      destructiveReason: "post a public review comment on the PR",
    },
    async run(input) {
      return { echoed: input.text };
    },
  };

  it("list() surfaces destructiveReason for destructive tools", () => {
    const reg = new ToolRegistry();
    reg.register(destructiveTool);
    expect(reg.list()).toEqual([
      {
        name: "post_review_comment",
        description: "post a comment on the PR",
        destructive: true,
        destructiveReason: "post a public review comment on the PR",
      },
    ]);
  });

  it("list() returns destructiveReason=null for non-destructive tools", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const entries = reg.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.destructive).toBe(false);
    expect(entries[0]?.destructiveReason).toBeNull();
  });

  it("list() distinguishes the two when both kinds are registered", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    reg.register(destructiveTool);
    const byName = new Map(reg.list().map((e) => [e.name, e]));
    expect(byName.get("echo")?.destructiveReason).toBeNull();
    expect(byName.get("post_review_comment")?.destructiveReason).toBe(
      "post a public review comment on the PR",
    );
  });
});
