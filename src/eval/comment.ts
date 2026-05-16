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

export function renderEvalMarkdown(run: EvalRun): string {
  const lines: string[] = [];
  lines.push(STICKY_MARKER);
  lines.push("");
  const headline = headlineFor(run);
  lines.push(`# Agent eval · ${run.cases.length} fixture(s) · ${headline}`);
  lines.push("");
  lines.push(
    `composite **${run.composite_mean.toFixed(3)}** · ` +
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
        `| ${c.score.composite.toFixed(3)} |`,
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
  if (run.composite_mean >= 0.85) return ":white_check_mark: composite ≥ 0.85";
  if (run.composite_mean >= 0.65) return ":warning: composite < 0.85";
  return ":x: composite < 0.65";
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function resolveToken(opts: UpsertOptions): string {
  if (opts.token) return opts.token;
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!env) {
    throw new Error(
      "GitHub token missing: pass `token` or set GITHUB_TOKEN / GH_TOKEN. " +
        "In Actions, `permissions: pull-requests: write` makes this automatic.",
    );
  }
  return env;
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
