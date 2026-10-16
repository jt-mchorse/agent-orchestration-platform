import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The run-detail status line keeps a space on both sides of every `·` (#227).
 *
 * htm, which `index.html` loads from esm.sh at 3.1.1, applies
 * `replace(/^\s*\n\s*|\s*\n\s*$/g, "")` to each static text chunk of a
 * template, so whitespace that contains a newline is dropped at a chunk's
 * edges. That is how indentation between tags disappears. It is also applied
 * where a chunk meets an interpolation, so a line that ends in text, followed
 * by a line that starts with `${...}`, loses the space between them. The status
 * line was laid out exactly that way and rendered `·1200/300 tokens ·$0.02`.
 *
 * No browser runs in CI and htm is not an npm dependency (D-006), so the test
 * applies htm's rule, quoted above, to the shipped template source.
 */
const APP_JS = readFileSync(path.resolve(__dirname, "../../src/ui/app.js"), "utf8");

/** htm 3.1.1's per-chunk whitespace trim, verbatim. */
const htmTrim = (chunk: string): string => chunk.replace(/^\s*\n\s*|\s*\n\s*$/g, "");

/** The status line's children, from `Status:` to its closing `</div>`. */
function statusLineSource(): string {
  const start = APP_JS.indexOf("Status: <span");
  if (start < 0) throw new Error("status line not found in src/ui/app.js");
  const end = APP_JS.indexOf("</div>", start);
  // Re-include the newline + indentation that precedes `Status:` in the file,
  // so the first chunk is trimmed the way htm sees it.
  const lineStart = APP_JS.lastIndexOf("\n", start);
  return APP_JS.slice(lineStart, end);
}

/** Render the status line the way htm + the browser would, with X for every value. */
function renderStatusLine(): string {
  const chunks = statusLineSource().split(/\$\{[^}]*\}|<[^>]*>/);
  return chunks
    .map(htmTrim)
    .join("X")
    .replace(/\s+/g, " ")
    .trim();
}

describe("trace viewer app.js: run-detail status line (#227)", () => {
  it("every separator has a space on both sides", () => {
    const text = renderStatusLine();
    expect(text).toContain("·");
    for (const m of text.matchAll(/·/g)) {
      const i = m.index as number;
      expect(text.slice(i - 1, i + 2), text).toBe(" · ");
    }
  });

  it("renders the expected shape", () => {
    // Values are X; `<span>` tags around the status are elided to X as well.
    expect(renderStatusLine()).toBe("Status: XXX · Started X · Finalized X · X/X tokens · X");
  });

  it("no html template line ends in text just before a line that starts with an interpolation", () => {
    const offenders = [...APP_JS.matchAll(/[^\s>`({]([ \t]*\n\s*)\$\{/g)].map((m) => {
      const line = APP_JS.slice(0, m.index).split("\n").length;
      return `src/ui/app.js:${line}: ${APP_JS.split("\n")[line - 1]?.trim()}`;
    });
    expect(offenders).toEqual([]);
  });
});
