import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every trace event kind has a timeline body and a dot colour (#225).
 *
 * The viewer (#6) shipped two days before #5 added `retry_attempted` and
 * `fallback_used` to the `TraceEvent` union, and nothing tied `eventBody`'s
 * switch to the union. Both kinds fell to `default: shortJson(ev)`, whose
 * 120-char cut spent its budget on the `ts` and `kind` the row header already
 * shows and ended inside `error`, so the failure message never appeared.
 *
 * `app.js` imports React from a CDN and renders at import time, so it cannot be
 * imported here. The helpers are evaluated from the shipped source verbatim.
 */
const ROOT = path.resolve(__dirname, "../..");
const APP_JS = readFileSync(path.join(ROOT, "src/ui/app.js"), "utf8");
const INDEX_HTML = readFileSync(path.join(ROOT, "src/ui/index.html"), "utf8");
const TRACE_TS = readFileSync(path.join(ROOT, "src/agent/trace.ts"), "utf8");

function fnSource(name: string): string {
  const m = APP_JS.match(new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"));
  if (!m) throw new Error(`${name} not found in src/ui/app.js`);
  return m[0];
}

/** `eventBody` plus every top-level helper it may call. */
const eventBody = new Function(
  ["recoLabel", "shortJson", "errorLine", "eventBody"]
    .filter((n) => APP_JS.includes(`function ${n}(`))
    .map(fnSource)
    .join("\n") + "\nreturn eventBody;",
)() as (ev: unknown) => string;

/** The kinds the `TraceEvent` union declares, read from the type itself. */
const TRACE_EVENT_BLOCK = TRACE_TS.match(/export type TraceEvent =([\s\S]*?)\};\n/)?.[1] ?? "";
const KINDS = [...TRACE_EVENT_BLOCK.matchAll(/kind: "([a-z_]+)"/g)].map((m) => m[1] as string);

const error = {
  name: "ToolError",
  kind: "timeout",
  toolName: "read_file_at_ref",
  message: "[read_file_at_ref:timeout] GitHub did not answer within 10000 ms",
};

describe("trace viewer app.js: eventBody (#225)", () => {
  it("reads the TraceEvent union it checks against", () => {
    expect(KINDS).toContain("retry_attempted");
    expect(KINDS).toContain("fallback_used");
    expect(KINDS.length).toBeGreaterThanOrEqual(9);
  });

  it("a retry_attempted body names the tool, attempt, backoff and the error message", () => {
    const body = eventBody({
      ts: 1760000000003,
      kind: "retry_attempted",
      toolName: "read_file_at_ref",
      attempt: 2,
      backoffMs: 400,
      error,
    });
    expect(body).toContain(error.message);
    expect(body).toContain("timeout");
    expect(body).toContain("read_file_at_ref");
    expect(body).toContain("2");
    expect(body).toContain("400ms");
    expect(body).not.toContain('"kind"');
  });

  it("a fallback_used body names both tools and the error message", () => {
    const body = eventBody({
      ts: 1760000000004,
      kind: "fallback_used",
      from: "read_file_at_ref",
      to: "fetch_pr",
      error,
    });
    expect(body).toContain(error.message);
    expect(body).toContain("read_file_at_ref");
    expect(body).toContain("fetch_pr");
    expect(body).not.toContain('"kind"');
  });

  it("an observation error still reads <kind> — <message>", () => {
    const body = eventBody({
      ts: 1760000000005,
      kind: "observation",
      observation: { step: { tool: "read_file_at_ref" }, outcome: { kind: "error", error } },
    });
    expect(body).toBe(`error: timeout — ${error.message}`);
  });

  it.each(KINDS)("eventBody has its own case for %s, not the raw-JSON default", (kind) => {
    expect(fnSource("eventBody")).toContain(`case "${kind}":`);
  });

  it.each(KINDS)("index.html gives %s a timeline dot colour", (kind) => {
    expect(INDEX_HTML).toMatch(new RegExp(`\\.event\\.${kind}(\\.[a-z]+)?::before\\s*\\{`));
  });
});

/** `String.prototype.isWellFormed` without the es2024 lib: no lone surrogate. */
function isWellFormed(s: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

describe("trace viewer app.js: shortJson cuts on a code-point boundary (#233)", () => {
  // `{"text":"` is 9 UTF-16 units, so `prefix` units of "a" put the next
  // character at unit 9 + prefix. The cut keeps units 0..116.
  // The key variant: `{"` is 2 units, so 114 units of "k" put the emoji at 116.
  const E = String.fromCodePoint(0x1f600);
  const PREFIX = "ok: search_repo → ";
  const okBody = (value: unknown) =>
    eventBody({
      ts: 1760000000006,
      kind: "observation",
      observation: { step: { tool: "search_repo" }, outcome: { kind: "ok", value } },
    });

  it.each([
    ["an emoji spanning units 116-117", { text: "a".repeat(107) + E.repeat(3) }],
    ["an emoji run ending on the cut", { text: "a".repeat(105) + E.repeat(4) }],
    ["a long string key with the emoji on the cut", { ["k".repeat(114) + E + "z".repeat(20)]: 1 }],
  ])("%s: the row stays well-formed and ends in ...", (_label, value) => {
    const body = okBody(value);
    expect(isWellFormed(body)).toBe(true);
    expect(body.endsWith("...")).toBe(true);
    // Maximal: only the split pair is dropped, so 116 units remain before "...".
    expect(body.length).toBe(PREFIX.length + 116 + 3);
  });

  it("control: an emoji wholly inside the kept prefix is kept, cut stays at 117", () => {
    const body = okBody({ text: "a".repeat(106) + E.repeat(3) });
    expect(isWellFormed(body)).toBe(true);
    expect(body.length).toBe(PREFIX.length + 117 + 3);
  });

  it("control: a value under 120 units is rendered whole", () => {
    expect(okBody({ text: E })).toBe(`${PREFIX}{"text":"${E}"}`);
  });
});
