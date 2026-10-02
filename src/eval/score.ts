import type { Finding, Review } from "../agent/types.js";
import { type Rational, add, rational, scale, toDouble } from "./exact.js";

/**
 * Score an agent's `Review` against the hand-labeled golden review.
 *
 * Three sub-metrics, each a number in [0, 1]:
 *
 * 1. **`recommendation_match`** — exact 3-class classification. 1.0 when
 *    the agent's `recommendation` equals the golden's; 0.0 otherwise.
 *    Most heavily weighted in the composite because it's the actionable
 *    output a human reviewer would use.
 * 2. **`findings_f1`** — F1 over a 1:1 fuzzy match between the agent's
 *    and golden's findings, keyed by `severity`. Two findings match if
 *    their token-overlap Jaccard similarity is ≥ 0.30 *and* their
 *    severities are equal. Each golden finding pairs with at most one
 *    agent finding (greedy by best similarity, D-011). Reports
 *    precision / recall separately for transparency.
 * 3. **`summary_length_ratio`** — `min(actual, golden) / max(actual, golden)`
 *    on character count. A crude proxy for "the summary is in the same
 *    ballpark". The semantic faithfulness of the summary is deferred to
 *    a future `llm-eval-harness.Judge` wire-up; this layer ships the
 *    structural numbers.
 *
 * `composite` is a weighted average: 0.5 × recommendation + 0.4 × findings_f1
 * + 0.1 × summary_length_ratio. The weights reflect the relative
 * stakes — getting the recommendation wrong is worse than a slightly
 * different summary length.
 */
export interface ReviewScore {
  recommendation_match: number;
  recommendation_actual: Review["recommendation"];
  recommendation_golden: Review["recommendation"];

  findings_precision: number;
  findings_recall: number;
  findings_f1: number;
  matched_findings: number;
  total_actual_findings: number;
  total_golden_findings: number;

  summary_length_ratio: number;
  summary_actual_chars: number;
  summary_golden_chars: number;

  composite: number;
}

// Whole tenths, so the composite is an exact rational (#163).
const WEIGHT_RECOMMENDATION_TENTHS = 5;
const WEIGHT_FINDINGS_TENTHS = 4;
const WEIGHT_SUMMARY_TENTHS = 1;

/** The exact composite of one review, from its integer-derived parts (#163). */
export function compositeExact(recMatch: number, f1: Rational, lenRatio: Rational): Rational {
  return add(
    add(rational(WEIGHT_RECOMMENDATION_TENTHS * recMatch, 10), scale(f1, WEIGHT_FINDINGS_TENTHS, 10)),
    scale(lenRatio, WEIGHT_SUMMARY_TENTHS, 10),
  );
}

/** `compositeExact`, re-derived from a finished `ReviewScore`'s integer fields. */
export function compositeExactOf(s: ReviewScore): Rational {
  const bothEmpty = s.total_actual_findings === 0 && s.total_golden_findings === 0;
  const f1 = bothEmpty
    ? rational(1)
    : s.matched_findings === 0
      ? rational(0)
      : rational(2 * s.matched_findings, s.total_actual_findings + s.total_golden_findings);
  const hi = Math.max(s.summary_actual_chars, s.summary_golden_chars);
  const ratio = hi === 0 ? rational(1) : rational(Math.min(s.summary_actual_chars, s.summary_golden_chars), hi);
  return compositeExact(s.recommendation_match, f1, ratio);
}
const JACCARD_MATCH_THRESHOLD = 0.3;

export function scoreReview(actual: Review, golden: Review): ReviewScore {
  const rec_match = actual.recommendation === golden.recommendation ? 1 : 0;

  const matches = matchFindings(actual.findings, golden.findings);
  const matched = matches.length;
  const total_actual = actual.findings.length;
  const total_golden = golden.findings.length;
  // When both sides report zero findings the agent correctly found nothing
  // on a clean PR — a *perfect* agreement, so precision/recall/F1 are 1.0.
  // This matches the both-empty convention `jaccard` (line ~145) and
  // `summary_length_ratio` (below) already use; without it a perfect clean
  // review scored findings_f1=0 and lost the full 0.4 findings weight
  // (composite capped at 0.6). The asymmetric cases are unchanged: a
  // hallucinated finding (golden empty, actual non-empty) keeps precision 0
  // and a missed finding (golden non-empty, actual empty) keeps recall 0, so
  // both still score F1 0.
  const bothEmpty = total_actual === 0 && total_golden === 0;
  const precision = bothEmpty ? 1 : total_actual === 0 ? 0 : matched / total_actual;
  const recall = bothEmpty ? 1 : total_golden === 0 ? 0 : matched / total_golden;
  // F1 = 2PR/(P+R) = 2m/(a+g): one exact ratio of counts (#163). The
  // product-over-sum form rounded twice, so 1-of-9 came out 0.19999999999999998.
  const f1Exact: Rational = bothEmpty
    ? rational(1)
    : matched === 0
      ? rational(0)
      : rational(2 * matched, total_actual + total_golden);
  const f1 = toDouble(f1Exact);

  const actual_len = actual.summary.length;
  const golden_len = golden.summary.length;
  const len_ratio =
    Math.max(actual_len, golden_len) === 0
      ? 1
      : Math.min(actual_len, golden_len) / Math.max(actual_len, golden_len);

  // Exact, then rounded once (#163): in floats an exact 0.65 (rec match, 1 of 9
  // findings, summaries 70:100) came out 0.6499999999999999, below the band
  // `bandFor` puts 0.65 in.
  const lenRatioExact: Rational =
    Math.max(actual_len, golden_len) === 0
      ? rational(1)
      : rational(Math.min(actual_len, golden_len), Math.max(actual_len, golden_len));
  const composite = toDouble(compositeExact(rec_match, f1Exact, lenRatioExact));

  return {
    recommendation_match: rec_match,
    recommendation_actual: actual.recommendation,
    recommendation_golden: golden.recommendation,

    findings_precision: precision,
    findings_recall: recall,
    findings_f1: f1,
    matched_findings: matched,
    total_actual_findings: total_actual,
    total_golden_findings: total_golden,

    summary_length_ratio: len_ratio,
    summary_actual_chars: actual_len,
    summary_golden_chars: golden_len,

    composite,
  };
}

/**
 * Greedy 1:1 fuzzy match (D-011) between agent + golden findings.
 *
 * Pairs are built by scoring every (actual, golden) cross-product cell
 * with `jaccard(actual.message, golden.message) * severity_match`, then
 * repeatedly picking the highest-scoring pair until no remaining pair
 * is above the threshold. Linear in pairs count, which is fine for the
 * ~5-10 findings per fixture the lab actually has.
 */
export function matchFindings(
  actuals: Finding[],
  goldens: Finding[],
): Array<{ actual_index: number; golden_index: number; similarity: number }> {
  const pairs: Array<{ a: number; g: number; sim: number; key: string }> = [];
  for (let ai = 0; ai < actuals.length; ai += 1) {
    for (let gi = 0; gi < goldens.length; gi += 1) {
      const actual = actuals[ai] as Finding;
      const golden = goldens[gi] as Finding;
      if (actual.severity !== golden.severity) continue;
      const sim = jaccard(actual.message, golden.message);
      // Tie-break key, carried alongside the pair (#120). Built from the two
      // findings' own CONTENT, not their array positions, so it is stable under
      // permutation of either input array.
      //
      // U+0000 is written as the two-character escape `\u0000`, never as a raw
      // byte. A literal NUL in the source makes git classify this file as
      // BINARY, which costs every textual diff, blame and merge on it. The
      // resulting string value is identical either way.
      //
      // The separator is NOT claimed to make the concatenation injective:
      // `message` is free-form and JSON can carry a U+0000 inside a string, so
      // two distinct pairs can in principle produce one key. That is tolerable
      // and not worth a length prefix -- a collision only makes those two pairs
      // compare equal again, i.e. it degrades to the pre-fix tie for that one
      // input. What the tiebreak requires is that the key be a deterministic
      // function of the two findings' content, and that holds unconditionally.
      if (sim >= JACCARD_MATCH_THRESHOLD) {
        pairs.push({
          a: ai,
          g: gi,
          sim,
          key: `${actual.severity}\u0000${actual.message}\u0000${golden.severity}\u0000${golden.message}`,
        });
      }
    }
  }
  // Descending similarity, then the content key (#120). Sorting on `sim` alone
  // left ties in nested-loop insertion order — i.e. the order the findings
  // happened to be LISTED — and the greedy walk below consumes pairs in that
  // order, so which findings ended up matched depended on the listing.
  //
  // Measured on the pre-fix source, same three actuals and same three goldens,
  // distinct messages, all `severity: "high"`, only the golden order differing:
  //
  //   A = [a / b / a b]
  //   G = [a b / a b c / a c d]  ->  2 matches, f1 0.6667, composite 0.8667
  //   G = [a b / a c d / a b c]  ->  3 matches, f1 1.0000, composite 1.0000
  //
  // One ordering reported a PERFECT score for the same review. The mechanism
  // needs a tie at the top of the list: when `(A0,G1)` and `(A0,G2)` score
  // equally and `G1` is the only viable partner for some other actual, taking
  // `(A0,G1)` first strands that actual and taking `(A0,G2)` first does not.
  // Equal Jaccard values are ordinary here — `tokenize` reduces each message to
  // a token Set, so a general finding, a specific one, and a combined one
  // routinely tie against several goldens.
  //
  // The tiebreak is on CONTENT, not on `p.a - q.a`. An index tiebreak would make
  // the result independent of the sort's stability but NOT of the input order,
  // which is the actual defect. Same reasoning and same fix shape as
  // chunking-strategies-lab#68 (tie-break on the chunk's stable identity) and
  // rag-production-kit#40 (tie-break on doc id): for a measurement lab the score
  // must be a pure function of the two finding sets.
  //
  // Plain code-unit `<` comparison, deliberately not `localeCompare` — the
  // locale-dependence of that call is the open question in #119, and there is no
  // reason to introduce it here.
  //
  // D-011 is completed, not revisited: only EQUALLY-scoring pairs change relative
  // order, so the greedy 1:1 walk and the severity lock are untouched.
  pairs.sort((p, q) => {
    if (q.sim !== p.sim) return q.sim - p.sim;
    if (p.key < q.key) return -1;
    if (p.key > q.key) return 1;
    return 0;
  });
  const usedA = new Set<number>();
  const usedG = new Set<number>();
  const out: Array<{ actual_index: number; golden_index: number; similarity: number }> = [];
  for (const pair of pairs) {
    if (usedA.has(pair.a) || usedG.has(pair.g)) continue;
    usedA.add(pair.a);
    usedG.add(pair.g);
    out.push({ actual_index: pair.a, golden_index: pair.g, similarity: pair.sim });
  }
  return out;
}

/**
 * Token-level Jaccard similarity between two strings.
 *
 * Splits on whitespace and punctuation, lowercases, drops empty
 * tokens. The score is `|A ∩ B| / |A ∪ B|` ∈ [0, 1]. Adequate for the
 * "are these two findings about the same thing" question — both are
 * short prose. A future PR could swap in cosine over embeddings if
 * findings get longer.
 */
export function jaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection += 1;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[\s,.;:!?()\[\]{}/\\"'`]+/)) {
    if (raw.length > 0) out.add(raw);
  }
  return out;
}
