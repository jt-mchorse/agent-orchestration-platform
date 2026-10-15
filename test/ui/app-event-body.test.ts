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
