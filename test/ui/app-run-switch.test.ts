import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Changing `#run=` renders the new run, not the old one's state (#229).
 *
 * `RunDetail` loaded in `useEffect(..., [runId])` but never reset `err` or
 * `run`, and `App` mounted it without a `key`, so one component instance and
 * its state served every run. Measured with the shipped `app.js` rendered in
 * jsdom (React 18.3, htm 3.1): `#run=missing` then `#run=good` fetched the good
 * run and kept "Failed to load run: HTTP 404"; and a slow response for the
 * previous run resolved last and replaced the current one, while the URL named
 * the current one.
 *
 * `app.js` imports React from a CDN, so as in the other UI tests the source is
 * checked: the two halves of the fix, each of which closes one of the two
 * symptoms.
 */
const APP_JS = readFileSync(path.resolve(__dirname, "../../src/ui/app.js"), "utf8");

function functionBody(name: string): string {
  const m = APP_JS.match(new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"));
  if (!m) throw new Error(`${name} not found in src/ui/app.js`);
  return m[0];
}

/** `src` without whole-line `//` comments, which may quote the old shape. */
function code(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("trace viewer app.js: switching runs (#229)", () => {
  it("App mounts RunDetail keyed by runId, so a new run starts from empty state", () => {
    const app = code(functionBody("App"));
    const mounts = [...app.matchAll(/<\$\{RunDetail\}([^>]*)\/>/g)].map((m) => m[1] as string);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatch(/\bkey=\$\{runId\}/);
  });

  it("the load effect drops a response for a run it no longer shows", () => {
    const detail = code(functionBody("RunDetail"));
    const effect = detail.match(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[runId\]\);/)?.[1];
    expect(effect, "RunDetail's [runId] effect").toBeDefined();
    // A cleanup is returned...
    expect(effect).toMatch(/return \(\) => \{\s*(\w+) = false;\s*\};/);
    const flag = (effect as string).match(/return \(\) => \{\s*(\w+) = false;/)?.[1] as string;
    // ...and both setters are guarded by the flag it clears.
    expect(effect).toMatch(new RegExp(`if \\(${flag}\\) setRun\\(`));
    expect(effect).toMatch(new RegExp(`if \\(${flag}\\) setErr\\(`));
    // Anti-vacuity: no unguarded setter call is left in the effect.
    const unguarded = (effect as string)
      .split("\n")
      .filter((line) => /\bset(Run|Err)\b/.test(line) && !line.includes(`if (${flag})`));
    expect(unguarded).toEqual([]);
  });
});
