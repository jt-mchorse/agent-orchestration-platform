/**
 * Markdown helpers shared by the two renderers that put untrusted values into
 * code spans: the eval sticky comment (`src/eval/comment.ts`) and the review
 * comment `post_review_comment` posts (`src/tools/post-review-comment.ts`).
 */

// Render `s` as one CommonMark inline code span (§6.1), whatever it contains.
// A fixed single-backtick fence is closed early by a backtick in the value
// (#244 in the eval comment, #295 in the review comment's finding anchor), so
// the fence is a backtick run one longer than the longest run in the value,
// which no run inside it can close. A value that starts or ends with a
// backtick, or both starts and ends with a space (and is not all spaces), is
// padded with one space each side; the renderer strips exactly that pair back
// off. A line ending cannot be represented: CommonMark turns it into a space
// inside a span, and a line that starts a block ends the span. Callers keep
// CR/LF out of the value (the review schema refuses them in `file`).
export function codeSpan(s: string): string {
  const longestRun = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = /^`|`$/.test(s) || (/^ /.test(s) && / $/.test(s) && /[^ ]/.test(s)) ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}
