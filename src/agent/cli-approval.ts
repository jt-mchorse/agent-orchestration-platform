import type { Readable, Writable } from "node:stream";
import type { ApprovalDecision, ApprovalProvider, ApprovalRequest } from "../tools/types.js";

export interface CliApprovalOptions {
  /** Stream to read y/n on. Defaults to process.stdin. */
  input?: Readable;
  /** Stream to print the prompt to. Defaults to process.stderr so stdout stays clean for tool output. */
  output?: Writable;
  /** Override the prompt rendering for tests or custom formatting. */
  format?: (req: ApprovalRequest) => string;
}

function defaultFormat(req: ApprovalRequest): string {
  const inputPreview = (() => {
    try {
      return JSON.stringify(req.input, null, 2);
    } catch {
      return String(req.input);
    }
  })();
  return [
    "",
    `==> Approval required for destructive tool: ${req.toolName}`,
    `    Effect: ${req.reason}`,
    `    Input:`,
    inputPreview
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n"),
    `    Approve? [y/N]: `,
  ].join("\n");
}

function readSingleLine(input: Readable, _output: Writable): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = "";
    let settled = false;
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buf);
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
  });
}

export function createCliApprovalProvider(opts: CliApprovalOptions = {}): ApprovalProvider {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const format = opts.format ?? defaultFormat;
  return {
    async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
      output.write(format(req));
      const answer = (await readSingleLine(input, output)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        return { approved: true };
      }
      return { approved: false, reason: `operator answered ${JSON.stringify(answer)}` };
    },
  };
}

/** Convenience provider that always approves; useful for replay-mode runs where the destructive call is a no-op. */
export const autoApproveProvider: ApprovalProvider = {
  async requestApproval() {
    return { approved: true, reason: "auto-approved (replay/test path)" };
  },
};

/** Convenience provider that always denies; useful as the default for safety. */
export const denyAllProvider: ApprovalProvider = {
  async requestApproval() {
    return { approved: false, reason: "no approver wired; denying by default" };
  },
};
