import type { Finding, Review } from "../agent/types.js";

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

const WEIGHT_RECOMMENDATION = 0.5;
const WEIGHT_FINDINGS = 0.4;
const WEIGHT_SUMMARY = 0.1;
const JACCARD_MATCH_THRESHOLD = 0.3;

export function scoreReview(actual: Review, golden: Review): ReviewScore {
  const rec_match = actual.recommendation === golden.recommendation ? 1 : 0;

  const matches = matchFindings(actual.findings, golden.findings);
  const matched = matches.length;
  const total_actual = actual.findings.length;
  const total_golden = golden.findings.length;
  const precision = total_actual === 0 ? 0 : matched / total_actual;
  const recall = total_golden === 0 ? 0 : matched / total_golden;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const actual_len = actual.summary.length;
  const golden_len = golden.summary.length;
  const len_ratio =
    Math.max(actual_len, golden_len) === 0
      ? 1
      : Math.min(actual_len, golden_len) / Math.max(actual_len, golden_len);

  const composite =
    WEIGHT_RECOMMENDATION * rec_match +
    WEIGHT_FINDINGS * f1 +
    WEIGHT_SUMMARY * len_ratio;

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
  const pairs: Array<{ a: number; g: number; sim: number }> = [];
  for (let ai = 0; ai < actuals.length; ai += 1) {
    for (let gi = 0; gi < goldens.length; gi += 1) {
      const actual = actuals[ai] as Finding;
      const golden = goldens[gi] as Finding;
      if (actual.severity !== golden.severity) continue;
      const sim = jaccard(actual.message, golden.message);
      if (sim >= JACCARD_MATCH_THRESHOLD) pairs.push({ a: ai, g: gi, sim });
    }
  }
  pairs.sort((p, q) => q.sim - p.sim);
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
