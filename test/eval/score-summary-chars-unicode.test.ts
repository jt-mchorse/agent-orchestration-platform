/**
 * `summary_length_ratio` counts code points of the NFC form (#281).
 *
 * The findings tokenizer NFC-normalizes (#186) but the summary length was
 * `String.length`: UTF-16 code units of the text as given. Measured on `main`
 * da3ca3c, one review vs a golden with the identical sentence as its summary
 * and its one finding:
 *   NFC (byte-identical)  chars 68 / 68  ratio 1.0000  f1 1  composite 1
 *   NFD (same text)       chars 72 / 68  ratio 0.9444  f1 1  composite 0.99444
 * and "ok " + five U+1F680 + " done" counted 18 for 13 code points.
 *
 * Strings are built from escapes so the NFC/NFD distinction survives editors
 * and round trips that normalize source text.
 */
import { describe, expect, it } from "vitest";

import type { Review } from "../../src/agent/types";
import { compositeExactOf, scoreReview } from "../../src/eval/score";
import { toDouble } from "../../src/eval/exact";

const NFC = "Caf\u00e9 r\u00e9sum\u00e9 na\u00efve: the retry loop doesn't validate maxAttempts here.";
const NFD = NFC.normalize("NFD");

function review(summary: string, message: string): Review {
  return { summary, findings: [{ severity: "concern", message }], recommendation: "approve" };
}

describe("summary_length_ratio unit (#281)", () => {
  it("the fixture really is two encodings of one text", () => {
    expect(NFD).not.toBe(NFC);
    expect(NFD.length).toBeGreaterThan(NFC.length);
    expect(NFD.normalize("NFC")).toBe(NFC);
  });

  it("an NFD copy of the golden summary scores ratio 1 and composite 1, like its findings", () => {
    const s = scoreReview(review(NFD, NFD), review(NFC, NFC));
    expect(s.findings_f1).toBe(1);
    expect(s.summary_actual_chars).toBe(s.summary_golden_chars);
    expect(s.summary_length_ratio).toBe(1);
    expect(s.composite).toBe(1);
  });

  it("the count is code points of the NFC form, on both sides", () => {
    const s = scoreReview(review(NFD, "x"), review(NFD, "x"));
    expect(s.summary_actual_chars).toBe([...NFC].length);
    expect(s.summary_golden_chars).toBe([...NFC].length);
  });

  it("an astral character counts as one", () => {
    const rocket = "\u{1F680}";
    const text = `ok ${rocket.repeat(5)} done`;
    expect(text.length).toBe(18);
    const s = scoreReview(review(text, "x"), review("a".repeat(13), "x"));
    expect(s.summary_actual_chars).toBe(13);
    expect(s.summary_length_ratio).toBe(1);
  });

  // Controls: green before and after the fix.
  it("compositeExactOf re-derives the same composite from the char fields", () => {
    const s = scoreReview(review(NFD, NFD), review(NFC.slice(0, 40), NFC));
    expect(toDouble(compositeExactOf(s))).toBe(s.composite);
  });

  it("a combining sequence with no precomposed form stays two code points", () => {
    // q + U+0301 has no NFC composite: code points, not grapheme clusters.
    const s = scoreReview(review("q\u0301", "x"), review("ab", "x"));
    expect(s.summary_actual_chars).toBe(2);
    expect(s.summary_length_ratio).toBe(1);
  });
});
