/**
 * An answer typed between two approval prompts is kept, and stdin does not
 * keep the process alive after the last prompt (#179).
 *
 * `readSingleLine` read with `on("data")`, which puts the stream in flowing
 * mode, and its cleanup removed the listener without pausing: bytes that
 * arrived while the approved tool ran were emitted to nobody (the next
 * approval hung), and a flowing stdin held the event loop open.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterAll, describe, expect, it } from "vitest";

import { createCliApprovalProvider } from "../src/agent/cli-approval.js";

const REQ = { toolName: "post_review_comment", reason: "post", input: { owner: "a", repo: "b", number: 1 } };
const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });

describe("an answer typed between prompts (#179)", () => {
  it("is kept for the next approval instead of being dropped", async () => {
    const input = new PassThrough();
    const provider = createCliApprovalProvider({ input, output: sink() });
    const first = provider.requestApproval(REQ);
    input.write("y\n");
    expect((await first).approved).toBe(true);
    // The operator answers ahead, while step 1's tool is still running.
    input.write("y\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(input.readableFlowing).toBe(false);
    const second = await Promise.race([
      provider.requestApproval(REQ),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 500)),
    ]);
    expect(second).not.toBe("hung");
    expect((second as { approved: boolean }).approved).toBe(true);
  });
});

const scratch = mkdtempSync(path.join(os.tmpdir(), "aop-approval-alive-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("stdin after the last approval (#179)", () => {
  it("does not keep the process alive while the pipe stays open", async () => {
    const script = path.join(scratch, "one-approval.mts");
    writeFileSync(
      script,
      `import { createCliApprovalProvider } from ${JSON.stringify(path.resolve(__dirname, "../src/agent/cli-approval.ts"))};
const p = createCliApprovalProvider({ input: process.stdin, output: process.stderr });
const d = await p.requestApproval(${JSON.stringify(REQ)});
console.log("approved=" + d.approved);
`,
    );
    const child = spawn("npx", ["tsx", script], { cwd: path.resolve(__dirname, ".."), stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.write("y\n"); // ...and keep the pipe open, as a terminal does
    const started = Date.now();
    const exited = await Promise.race([
      new Promise<number>((r) => child.on("exit", () => r(Date.now() - started))),
      new Promise<"alive">((r) => setTimeout(() => r("alive"), 8_000)),
    ]);
    child.stdin.end();
    if (exited === "alive") child.kill();
    expect(out).toContain("approved=true");
    expect(exited).not.toBe("alive");
  }, 20_000);

  it("still waits for an answer that arrives late", async () => {
    const script = path.join(scratch, "late-answer.mts");
    writeFileSync(
      script,
      `import { createCliApprovalProvider } from ${JSON.stringify(path.resolve(__dirname, "../src/agent/cli-approval.ts"))};
const p = createCliApprovalProvider({ input: process.stdin, output: process.stderr });
const d = await p.requestApproval(${JSON.stringify(REQ)});
console.log("approved=" + d.approved);
`,
    );
    const child = spawn("npx", ["tsx", script], { cwd: path.resolve(__dirname, ".."), stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    await new Promise((r) => setTimeout(r, 1_500));
    child.stdin.write("y\n");
    child.stdin.end();
    await exited;
    expect(out).toContain("approved=true");
  }, 20_000);
});
