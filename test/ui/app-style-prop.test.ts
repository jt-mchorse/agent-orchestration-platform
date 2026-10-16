import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The trace viewer's run-detail screen was blank for every run (#221).
 *
 * `RunDetail` carried `<div style="margin-top: 10px; ...">`. `htm` passes an
 * attribute through as a string prop, and `React.createElement` accepts only an
 * object for `style`: it throws minified error #62, and with no error boundary
 * the throw unmounts the whole root. The list screen has no such attribute, so
 * the viewer looked healthy until a row was clicked.
 *
 * No browser runs in CI, and `app.js` imports React from a CDN, so it cannot be
 * rendered here. What can be checked is the shape React rejects
 * unconditionally: a quoted `style=` value in an `htm` template is a crash on
 * the first render that reaches it, whatever the data. The fix moves the rule
 * into `index.html`'s `<style>` block, so the second check pins that every
 * static class `app.js` uses is actually defined there.
 */
const UI_DIR = path.resolve(__dirname, "../../src/ui");
const APP_JS = readFileSync(path.join(UI_DIR, "app.js"), "utf8");
const INDEX_HTML = readFileSync(path.join(UI_DIR, "index.html"), "utf8");

/** `app.js` without its whole-line `//` comments, which may quote the bad shape. */
function codeLines(): string[] {
  return APP_JS.split("\n").filter((line) => !/^\s*\/\//.test(line));
}

describe("trace viewer app.js: React-compatible style props (#221)", () => {
  it("passes `style` a quoted string nowhere (React throws #62 on it)", () => {
    const offending = codeLines().filter((line) => /\bstyle\s*=\s*["']/.test(line));
    expect(offending).toEqual([]);
  });

  it("the run-detail metadata line uses a class, and index.html defines it", () => {
    expect(APP_JS).toContain('<div class="meta">');
    expect(INDEX_HTML).toMatch(/\.review \.meta\s*\{[^}]*margin-top: 10px/);
  });

  it("every static class app.js renders is defined in index.html's <style>", () => {
    const styleBlock = INDEX_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const used = new Set<string>();
    for (const line of codeLines()) {
      for (const m of line.matchAll(/\bclass="([^"]*)"/g)) {
        for (const name of (m[1] as string).split(/\s+/)) if (name) used.add(name);
      }
    }
    // Anti-vacuity: the templates do use static classes.
    expect(used.size).toBeGreaterThan(5);
    const undefinedClasses = [...used].filter(
      (name) => !new RegExp(`\\.${name.replace(/[-_]/g, "\\$&")}(?![\\w-])`).test(styleBlock),
    );
    expect(undefinedClasses).toEqual([]);
  });
});
