import type { Readable, Writable } from "node:stream";
import type { ApprovalDecision, ApprovalProvider, ApprovalRequest } from "../tools/types.js";
import { postReviewCommentTool, renderPreview } from "../tools/post-review-comment.js";

export interface CliApprovalOptions {
  /** Stream to read y/n on. Defaults to process.stdin. */
  input?: Readable;
  /** Stream to print the prompt to. Defaults to process.stderr so stdout stays clean for tool output. */
  output?: Writable;
  /** Override the prompt rendering for tests or custom formatting. */
  format?: (req: ApprovalRequest) => string;
}

/**
 * The text the operator reviews before approving. For `post_review_comment`
 * that is the rendered Markdown comment, built by the poster's own
 * `renderPreview`, so the operator approves the text that would be posted
 * (#250). A JSON dump showed the summary as an escaped one-line string and the
 * findings as nested objects -- not the comment the README and use-case doc
 * promise. Any other tool, or an input that does not parse as a review comment
 * (a direct caller can pass anything), keeps the JSON preview.
 */
function previewFor(req: ApprovalRequest): { label: string; body: string } {
  if (req.toolName === postReviewCommentTool.name) {
    const parsed = postReviewCommentTool.inputSchema.safeParse(req.input);
    if (parsed.success) {
      return { label: "Comment", body: renderPreview(parsed.data) };
    }
  }
  const json = (() => {
    try {
      return JSON.stringify(req.input, null, 2);
    } catch {
      return String(req.input);
    }
  })();
  return { label: "Input", body: json };
}

/**
 * Terminal-control and bidi codepoints the preview must not print raw (#257).
 * C0 except `\t` and `\n`, DEL, C1 (U+0080-009F; U+009B is an 8-bit CSI on
 * some terminals), and the bidi embeddings/overrides/isolates/marks. The
 * comment text comes from the planner's review of someone else's PR, so a PR
 * author can steer it: a CR or `ESC[2K` rewrites the line the operator is
 * reading, `ESC[8m` hides text, an RLO reorders it -- and the operator
 * approves something other than what gets posted. `JSON.stringify` escaped
 * C0 for the old JSON dump, but never C1 or bidi, so the fallback path goes
 * through this too.
 */
const TERMINAL_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * Make each unsafe codepoint visible instead of dropping it, so the operator
 * sees that something odd is there: `\r`, `\x1b`, `‮`.
 */
function escapeForTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE, (c) => {
    if (c === "\r") return "\\r";
    const code = c.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function defaultFormat(req: ApprovalRequest): string {
  const raw = previewFor(req);
  const preview = { label: raw.label, body: escapeForTerminal(raw.body) };
  return [
    "",
    `==> Approval required for destructive tool: ${req.toolName}`,
    `    Effect: ${req.reason}`,
    `    ${preview.label}:`,
    preview.body
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n"),
    `    Approve? [y/N]: `,
  ].join("\n");
}

/**
 * Reads one `\n`-terminated line from `input`, carrying any residual bytes
 * across calls via `carry`.
 *
 * A single provider's `requestApproval` is called once per destructive tool in
 * a run, all sharing the same `input` stream. Node routinely delivers several
 * buffered lines in one `data` chunk (piped stdin, or a fast typist). If each
 * call kept only a local buffer it would discard everything after the first
 * newline, so the *next* call would block forever on a line that already
 * arrived — a HITL deadlock plus silent loss of the operator's answer. `carry`
 * is a mutable box shared by the closure so the leftover of one read seeds the
 * next. Returns `{ line, carry }`; the caller threads the new carry back in.
 */
function readSingleLine(
  input: Readable,
  carry: string,
  alreadyEnded: boolean,
): Promise<{ line: string; carry: string }> {
  // A full line may already be sitting in the carry from a previous read; if so
  // resolve synchronously without touching the stream.
  const buffered = carry.indexOf("\n");
  if (buffered !== -1) {
    return Promise.resolve({ line: carry.slice(0, buffered), carry: carry.slice(buffered + 1) });
  }
  // The stream already reached EOF on a prior read. Node fires `end`/`close`
  // exactly once, so no `data`/`end`/`close` will ever arrive again — attaching
  // the listeners below would leave the promise unsettled forever, hanging the
  // 2nd+ approval after stdin EOF (a HITL deadlock). This is the EOF sibling of
  // the residual-drop deadlock #85 fixed. Resolve fail-closed with the residual
  // carry as the final line, exactly like the one-shot `onEnd` path does.
  if (alreadyEnded) {
    return Promise.resolve({ line: carry, carry: "" });
  }
  return new Promise<{ line: string; carry: string }>((resolve) => {
    let buf = carry;
    let settled = false;
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        if (settled) return;
        settled = true;
        cleanup();
        // Keep everything after the newline as the carry for the next read.
        resolve({ line: buf.slice(0, nl), carry: buf.slice(nl + 1) });
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ line: buf, carry: "" });
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      // `on("data")` put the stream in flowing mode, and removing the listener
      // does not take it out (#179): bytes typed between two prompts were
      // emitted to nobody -- the answer was lost and the next approval hung --
      // and a flowing stdin kept the process alive after the run. Paused, they
      // stay buffered for the next read, which resumes the stream explicitly.
      // Pausing alone does not release the event loop -- a paused stdin pipe
      // still held the process open until the writer closed it (measured: the
      // run exited when the pipe did, ~3.6 s later) -- so the handle is also
      // unref'd while no prompt is waiting, and ref'd again by the next read.
      input.pause();
      (input as { unref?: () => void }).unref?.();
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    // Explicitly: a `data` listener does NOT restart a stream that `pause()`
    // stopped, only one that was never paused (#179). And ref'd, so the
    // process waits for the operator's answer.
    (input as { ref?: () => void }).ref?.();
    input.resume();
  });
}

export function createCliApprovalProvider(opts: CliApprovalOptions = {}): ApprovalProvider {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const format = opts.format ?? defaultFormat;
  // Residual bytes read past one approval's newline, carried to the next.
  let carry = "";
  // Track EOF across sequential approvals. Node emits `end`/`close` exactly
  // once; a persistent listener records it so a later `readSingleLine` knows
  // not to attach one-shot listeners that will never fire (#101).
  let ended = false;
  const markEnded = () => {
    ended = true;
  };
  input.once("end", markEnded);
  input.once("close", markEnded);
  return {
    async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
      output.write(format(req));
      const alreadyEnded = ended || input.readableEnded === true;
      const read = await readSingleLine(input, carry, alreadyEnded);
      carry = read.carry;
      const answer = read.line.trim().toLowerCase();
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
