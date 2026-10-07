/**
 * The findings tokenizer splits on non-ASCII punctuation and normalizes to NFC (#186).
 *
 * `tokenize` split only on whitespace and a list of ASCII punctuation, so
 * typographic quotes, dashes and full-width punctuation stayed glued to their
 * words. Measured on `main` (a hunt agent, re-run here):
 *   "Retry 'maxAttempts' isn't validated" vs the same with ‘ ’  -> 0.2857
 *     (below D-011's 0.3 threshold: a correct finding scored as missed)
 *   NFC vs NFD "café crème"                                     -> 0.143
 * The dry-run eval over the shipped fixtures prints the same report before and
 * after this change.
 */
import { describe, expect, it } from "vitest";

import { jaccard } from "../../src/eval/score";

describe("tokenize via jaccard (#186)", () => {
  it.each([
    ["Retry 'maxAttempts' isn't validated", "Retry ‘maxAttempts’ isn’t validated"],
    ['the "retry" budget', "the “retry” budget"],
    ["index rebuild — slow", "index rebuild—slow"],
    ["recall dropped. latency rose.", "recall dropped。latency rose。"],
    ["café crème", "café crème"],
  ])("%s ~ %s scores 1", (a, b) => {
    expect(jaccard(a, b)).toBe(1);
  });

  it("the ASCII hyphen and underscore are still word characters (unchanged)", () => {
    expect(jaccard("re-entrant max_tokens", "re entrant max tokens")).toBe(0);
    expect(jaccard("re-entrant max_tokens", "re-entrant max_tokens")).toBe(1);
  });

  it("ASCII separators behave as before", () => {
    expect(jaccard("a,b;c:d!e?(f)[g]{h}/i\\j\"k'l`m", "a b c d e f g h i j k l m")).toBe(1);
  });
});
