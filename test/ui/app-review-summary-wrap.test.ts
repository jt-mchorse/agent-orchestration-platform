import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The review summary wraps like a timeline body does (#251).
 *
 * `.review .summary` carried only `font-size`, so its `white-space` was
 * `normal`: a multi-paragraph summary collapsed into one run-on paragraph, and
 * a long URL ran past the card's right edge (headless Chrome at 420 px measured
 * scrollWidth 491 against clientWidth 426). `.event .body` already had the
 * wrap rule; the summary, the review's main output, did not.
 *
 * The checks read the declarations of every rule whose selector list names the
 * class, from the shipped `<style>` block, so a rule split in two still counts.
 */
const UI_DIR = path.resolve(__dirname, "../../src/ui");
const INDEX_HTML = readFileSync(path.join(UI_DIR, "index.html"), "utf8");
const APP_JS = readFileSync(path.join(UI_DIR, "app.js"), "utf8");
const STYLE = (INDEX_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Merged `property -> value` for every rule whose selector list includes `selector`. */
function declarations(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of STYLE.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (m[1] as string).split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (!selectors.includes(selector)) continue;
    for (const decl of (m[2] as string).split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}

describe("trace viewer index.html: review summary wrapping (#251)", () => {
  it("app.js renders the run summary into the .summary element inside .review", () => {
    expect(APP_JS).toMatch(/<div class="review">\s*<div class="summary">\$\{run\.summary/);
  });

  it(".review .summary keeps the summary's newlines (white-space: pre-wrap)", () => {
    expect(declarations(".review .summary")["white-space"]).toBe("pre-wrap");
  });

  it(".review .summary breaks an unbreakable URL inside the card (overflow-wrap: anywhere)", () => {
    expect(declarations(".review .summary")["overflow-wrap"]).toBe("anywhere");
  });

  it(".review .summary keeps its font size", () => {
    expect(declarations(".review .summary")["font-size"]).toBe("14px");
  });

  it(".event .body keeps the wrap rule the summary now matches", () => {
    const body = declarations(".event .body");
    expect(body["white-space"]).toBe("pre-wrap");
    expect(body["word-break"]).toBe("break-word");
  });
});
