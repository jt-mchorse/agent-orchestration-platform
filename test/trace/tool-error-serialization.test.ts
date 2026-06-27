/**
 * Regression tests for #65: a ToolError must survive JSON serialization with
 * its `message` intact.
 *
 * `PgStore.writeRun` persists each event via `JSON.stringify(payloadOf(ev))`
 * (pg-store.ts:109) and reads it back with `JSON.parse`. `ToolError extends
 * Error`, and `Error` sets `message` as a *non-enumerable* own property, so
 * before the `toJSON()` fix `JSON.stringify` dropped it — every tool failure
 * persisted to Postgres lost its message and the run-detail UI rendered
 * "error: <kind> — undefined". These tests are hermetic (no DATABASE_URL):
 * they exercise the exact `JSON.stringify` → `JSON.parse` round-trip the
 * Postgres path performs, which the DB-gated integration tests never reach
 * (they only use plain-object `ok` outcomes).
 */

import { describe, expect, it } from "vitest";

import type { TraceEvent } from "../../src/agent/trace.js";
import { ToolError } from "../../src/tools/types.js";

function roundTrip<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe("ToolError JSON serialization (#65)", () => {
  it("preserves message + kind + toolName through a direct round-trip", () => {
    const e = new ToolError("fetch_pr", "internal", "fixture not found at /x");
    const r = roundTrip(e);
    expect(r.message).toBe("[fetch_pr:internal] fixture not found at /x");
    expect(r.kind).toBe("internal");
    expect(r.toolName).toBe("fetch_pr");
    expect(r.name).toBe("ToolError");
  });

  it("preserves the message inside an error observation event", () => {
    const error = new ToolError("ping", "not_found", "no such pr");
    const event: TraceEvent = {
      ts: 1,
      kind: "observation",
      observation: {
        step: { rationale: "r", tool: "ping", input: { msg: "hi" } },
        outcome: { kind: "error", error },
      },
    };
    const r = roundTrip(event);
    const outcome = (r.observation as { outcome: { error: { message: string } } }).outcome;
    expect(outcome.error.message).toBe("[ping:not_found] no such pr");
  });

  it("preserves the message inside retry_attempted and fallback_used events", () => {
    const error = new ToolError("ping", "internal", "boom");
    const retry: TraceEvent = {
      ts: 2,
      kind: "retry_attempted",
      toolName: "ping",
      attempt: 1,
      backoffMs: 100,
      error,
    };
    const fallback: TraceEvent = {
      ts: 3,
      kind: "fallback_used",
      from: "ping",
      to: "pong",
      error,
    };
    expect((roundTrip(retry).error as { message: string }).message).toBe("[ping:internal] boom");
    expect((roundTrip(fallback).error as { message: string }).message).toBe("[ping:internal] boom");
  });
});
