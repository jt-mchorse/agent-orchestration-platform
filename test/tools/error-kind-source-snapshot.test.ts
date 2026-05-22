/**
 * Source-text snapshot for the `ToolErrorKind` union (#21).
 *
 * `ToolErrorKind` is a TypeScript type-only export — at runtime it's
 * erased, so a runtime-introspection test can't see it. The five
 * companion tests in `live-mode-error-kind.test.ts` cover the runtime
 * surface (every tool with a live-mode stub throws `unsupported_in_live`);
 * this test covers the source-of-truth declaration so a future
 * copy-paste can't reintroduce the misnamed `unsupported_in_replay`
 * literal even if nobody happens to invoke a live-mode path in a test.
 *
 * It also asserts the retry helper's docstring still names the kind by
 * its new name, since the docstring is the operator's reference for why
 * `unsupported_in_live` isn't retried by default.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(here, "../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("ToolErrorKind source snapshot (#21)", () => {
  it("src/tools/types.ts includes the unsupported_in_live literal", () => {
    const src = read("src/tools/types.ts");
    expect(
      src,
      'src/tools/types.ts must declare `| "unsupported_in_live"` on the ' +
        "ToolErrorKind union. If the literal was renamed, update this snapshot.",
    ).toContain('| "unsupported_in_live"');
  });

  it("src/tools/types.ts does NOT include the legacy unsupported_in_replay literal", () => {
    const src = read("src/tools/types.ts");
    expect(
      src,
      "src/tools/types.ts must not contain the legacy `unsupported_in_replay` " +
        "literal (#21 renamed it because the name lied: it was thrown when mode " +
        'was LIVE, not replay). If the legacy literal is back, the rename regressed.',
    ).not.toContain("unsupported_in_replay");
  });

  it("src/agent/retry.ts docstring names the new kind", () => {
    const src = read("src/agent/retry.ts");
    expect(
      src,
      "src/agent/retry.ts's `DEFAULT_RETRYABLE_KINDS` docstring must name " +
        "unsupported_in_live as a deliberately-non-retried kind. The " +
        "docstring is the operator's reference for retry semantics.",
    ).toContain("unsupported_in_live");
    expect(
      src,
      "src/agent/retry.ts must not still reference the legacy " +
        "unsupported_in_replay name in its docstring.",
    ).not.toContain("unsupported_in_replay");
  });

  it("docs/architecture.md replan-trigger bullet names the new kind", () => {
    const src = read("docs/architecture.md");
    expect(
      src,
      "docs/architecture.md must name unsupported_in_live in the replan-trigger " +
        "taxonomy paragraph (#21). Otherwise the architecture doc references a " +
        "kind that doesn't exist in the type union.",
    ).toContain("unsupported_in_live");
    expect(
      src,
      "docs/architecture.md must not still reference the legacy " +
        "unsupported_in_replay name.",
    ).not.toContain("unsupported_in_replay");
  });
});
