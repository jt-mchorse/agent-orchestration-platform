import { firstNonBlank } from "../io/env.js";
import type { EvalRun } from "./runner.js";

/**
 * Sticky PR comment renderer + upsert for the agent eval suite (#7).
 *
 * Borrows the *idea* from llm-eval-harness (D-009 there): a hidden HTML
 * marker in the comment body lets the bot find its prior comment and
 * edit it in place on every push. The two repos use different markers
 * so a downstream consumer importing both doesn't accidentally
 * overwrite one with the other.
 */

export const STICKY_MARKER = "<!-- agent-eval:sticky-comment -->";

/**
 * The composite bands the headline reports, boundary-descending.
 *
 * One declaration instead of two copies. Before #147 each boundary appeared
 * twice -- once in a `>=` comparison and once spelled into the prose it returns
 * (`":warning: composite < 0.85"`) -- so the comparison and the sentence
 * describing it could drift apart, and a third band could be added with the
 * renderer left behind.
 *
 * `atLeast` is the inclusive floor; the last entry is the fallthrough and its
 * floor is `-Infinity` so the table is total over every finite composite.
 */
const COMPOSITE_BANDS: ReadonlyArray<{ atLeast: number; headline: string }> = [
  { atLeast: 0.85, headline: ":white_check_mark: composite ≥ 0.85" },
  { atLeast: 0.65, headline: ":warning: composite < 0.85" },
  { atLeast: -Infinity, headline: ":x: composite < 0.65" },
] as const;

/** Decimal places the composite has always been published at. */
const COMPOSITE_PLACES = 3;

/** Widening ceiling — a double round-trips in at most 17 significant digits. */
const MAX_PLACES = 17;

/** The band a composite falls in. Exported for the tests that sweep boundaries. */
export function bandFor(composite: number): string {
  for (const band of COMPOSITE_BANDS) {
    if (composite >= band.atLeast) return band.headline;
  }
  // Unreachable: the last band's floor is -Infinity, and NaN is rejected
  // upstream. Returned rather than thrown because a renderer must not be the
  // thing that fails a CI comment.
  return COMPOSITE_BANDS[COMPOSITE_BANDS.length - 1]!.headline;
}

/**
 * Render a composite so the printed number agrees with the headline beside it.
 *
 * The headline is decided at full precision and the value was published at a
 * fixed three places, so the comment could contradict itself across its own
 * first two lines (#147)::
 *
 *     composite 0.8499 -> ":warning: composite < 0.85"  beside  "composite 0.850"
 *     composite 0.6499 -> ":x: composite < 0.65"        beside  "composite 0.650"
 *
 * **This is a different rule from the one the sibling repos use**, and the
 * difference is why it gets its own decision (D-017). `prompt-regression-suite`
 * (D-012), `llm-eval-harness` (D-026) and `ai-app-integration-tests` (D-013) all
 * widen until two rendered *numbers* differ. There is no second number here: the
 * headline carries a *classification*, and the threshold it names is a string
 * literal. So the property is one step up --
 *
 *     the value as printed must classify into the same band as the value as
 *     measured
 *
 * -- or equivalently, **rendering must not change the verdict**. Expressed over
 * `bandFor` rather than over the boundaries directly, so a fourth band is
 * covered the moment it is added to `COMPOSITE_BANDS` and cannot be added with
 * this renderer left behind.
 *
 * Widening rather than a wider fixed width, for the reason the siblings give: a
 * fixed `toFixed(6)` still crosses a boundary at `0.8499999995`. And never
 * narrowing -- `llm-eval-harness#252` shipped exactly that regression in this
 * class, and only that repo's artifact lock caught it.
 */
export function renderComposite(composite: number, places = COMPOSITE_PLACES): string {
  const trueBand = bandFor(composite);
  for (let width = places; width <= MAX_PLACES; width++) {
    const rendered = composite.toFixed(width);
    if (bandFor(Number(rendered)) === trueBand) return rendered;
  }
  // No fixed width preserves the band. Unreachable for finite inputs at these
  // magnitudes, but the exponential form round-trips so the verdict holds.
  return composite.toExponential();
}

export function renderEvalMarkdown(run: EvalRun): string {
  const lines: string[] = [];
  lines.push(STICKY_MARKER);
  lines.push("");
  const headline = headlineFor(run);
  lines.push(`# Agent eval · ${run.cases.length} fixture(s) · ${headline}`);
  lines.push("");
  lines.push(
    // Through `renderComposite`, so this number cannot disagree with the
    // headline two lines above it (#147).
    `composite **${renderComposite(run.composite_mean)}** · ` +
      `recommendation accuracy **${(run.recommendation_accuracy * 100).toFixed(0)}%** · ` +
      `findings F1 **${run.findings_f1_mean.toFixed(3)}**`,
  );
  lines.push("");
  lines.push("| fixture | rec ✓? | findings F1 | summary len ratio | composite |");
  lines.push("| ------- | :----: | ----------: | ----------------: | --------: |");
  for (const c of run.cases) {
    const recMark = c.score.recommendation_match === 1 ? ":white_check_mark:" : ":x:";
    lines.push(
      `| \`${escape(c.fixture_id)}\` | ${recMark} ` +
        `(${escape(c.score.recommendation_actual)} vs ${escape(c.score.recommendation_golden)}) ` +
        `| ${c.score.findings_f1.toFixed(3)} ` +
        `| ${c.score.summary_length_ratio.toFixed(3)} ` +
        // Through `renderComposite` too (#149). D-017 routed the summary
        // line and stated its rule over "the comment's first two lines"; the
        // rule it actually established is a property of *any* published
        // composite, and this cell is one. On a single-fixture run this value
        // IS `composite_mean`, so at 0.8499 the headline said
        // `composite < 0.85` and this cell said `0.850`.
        `| ${renderComposite(c.score.composite)} |`,
    );
  }
  lines.push("");
  lines.push(
    "<sub>posted by " +
      "[agent-orchestration-platform](https://github.com/jt-mchorse/agent-orchestration-platform) " +
      "· this comment is updated in-place on every push</sub>",
  );
  return lines.join("\n") + "\n";
}

function headlineFor(run: EvalRun): string {
  if (run.cases.length === 0) return "no fixtures";
  // Reads the same band table the renderer does, so the headline and the number
  // below it cannot be decided by two different rules (#147).
  return bandFor(run.composite_mean);
}

// Escape a value for a GFM table cell that is also rendered as HTML (the
// sticky eval comment). The `&`/`<`/`>` entity escapes cover the HTML context;
// the `|` -> `\|` escape covers the GFM table-cell delimiter. Backticks do NOT
// protect a literal `|`: GitHub splits table cells on unescaped pipes *before*
// it parses inline-code spans, so an un-escaped pipe in the free-form
// `fixture_id` cell (`lang=py|framework=next`) injects a spurious column and
// corrupts the whole table's alignment. (The recommendation cells are enum-
// typed today, but they flow through here too so the guard covers them
// defensively if that type ever loosens.) GitHub renders `\|` as a
// literal pipe, inside a code span in a table too. This is the TS side of the
// portfolio-wide sweep (llm-eval-harness #130/#134, embedding-model-shootout
// #79, chunking-strategies-lab #100) that missed this repo (#89). Both call
// sites of `escape` are table cells, so the pipe escape belongs here.
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|");
}

// ---------- GitHub API plumbing (stdlib-only) ----------

interface PoolLike {
  fetch: (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;
}

export interface UpsertOptions {
  /** Inject `fetch` for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the API base. Defaults to https://api.github.com. */
  apiBase?: string;
  /** Override the GitHub token. Defaults to GITHUB_TOKEN / GH_TOKEN env. */
  token?: string;
  marker?: string;
}

const DEFAULT_API_BASE = "https://api.github.com";

/** Environment variables consulted, in precedence order. */
export const TOKEN_ENV_NAMES = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

function resolveToken(opts: UpsertOptions): string {
  // Was `if (opts.token) ...` followed by `process.env.GITHUB_TOKEN ??
  // process.env.GH_TOKEN`. The first line is a truthy check and is correct --
  // an empty `opts.token` falls through to the environment. The second used
  // `??`, which fires on null/undefined only, and the two disagreed about the
  // same idea one line apart (#124).
  //
  // Measured:
  //   GITHUB_TOKEN='' + GH_TOKEN set     THROWS "GitHub token missing ..."
  //   GITHUB_TOKEN='  ' + GH_TOKEN set   -> "  "  sent as `Bearer   `
  //
  // The first threw an error naming, among others, the variable that WAS
  // correctly set. The second is worse: `"  "` is truthy, so it slipped past
  // the `!env` guard below and turned a clear "token missing" into a 401.
  //
  // `firstNonBlank` applies one rule to the whole chain, `opts.token`
  // included, so the precedence is expressed by argument order and every
  // element is judged the same way.
  const token = firstNonBlank([opts.token, ...TOKEN_ENV_NAMES.map((n) => process.env[n])], "");
  if (!token) {
    throw new Error(
      `GitHub token missing: pass \`token\` or set ${TOKEN_ENV_NAMES.join(" / ")}. ` +
        "An empty or whitespace-only value counts as missing. " +
        "In Actions, `permissions: pull-requests: write` makes this automatic.",
    );
  }
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-eval-sticky-comment/1",
  };
}

export async function findStickyCommentId(
  repo: string,
  pr: number,
  opts: UpsertOptions = {},
): Promise<number | null> {
  const token = resolveToken(opts);
  const f = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const marker = opts.marker ?? STICKY_MARKER;
  for (let page = 1; page <= 10; page += 1) {
    const url = `${base}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`;
    const resp = await f(url, { method: "GET", headers: authHeaders(token) });
    if (!resp.ok) {
      throw new Error(`GitHub API GET ${url} -> ${resp.status}: ${await resp.text()}`);
    }
    const items = (await resp.json()) as Array<{ id: number; body?: string }>;
    if (!Array.isArray(items) || items.length === 0) return null;
    for (const item of items) {
      if ((item.body ?? "").includes(marker)) return item.id;
    }
    if (items.length < 100) return null;
  }
  return null;
}

export async function upsertStickyComment(
  repo: string,
  pr: number,
  body: string,
  opts: UpsertOptions = {},
): Promise<number> {
  const marker = opts.marker ?? STICKY_MARKER;
  if (!body.includes(marker)) {
    throw new Error("body is missing the sticky marker; refusing to upsert");
  }
  const token = resolveToken(opts);
  const f = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const existing = await findStickyCommentId(repo, pr, { ...opts, token });
  if (existing !== null) {
    const url = `${base}/repos/${repo}/issues/comments/${existing}`;
    const resp = await f(url, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ body }),
    });
    if (!resp.ok) {
      throw new Error(`GitHub API PATCH ${url} -> ${resp.status}: ${await resp.text()}`);
    }
    const j = (await resp.json()) as { id?: number };
    return j.id ?? existing;
  }
  const url = `${base}/repos/${repo}/issues/${pr}/comments`;
  const resp = await f(url, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ body }),
  });
  if (!resp.ok) {
    throw new Error(`GitHub API POST ${url} -> ${resp.status}: ${await resp.text()}`);
  }
  const j = (await resp.json()) as { id?: number };
  return j.id ?? 0;
}

// Suppress an unused-import warning since `PoolLike` is reserved for a
// future test-double type but not currently referenced.
const _unused: PoolLike | undefined = undefined;
void _unused;
