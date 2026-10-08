import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CoreDecision {
  id: string;
  date: string | null;
  decision: string | null;
  rationale: string | null;
  alternatives_rejected: string[];
  reversibility: "cheap" | "expensive" | "one-way" | "unknown";
  related_issues: string[];
  superseded_by: string | null;
}

const ID_LINE = /^-\s+id:\s*(.+?)\s*$/;
const KV_LINE = /^\s{2,}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;
const COMMENT_LINE = /^\s*#/;

// The decision files are YAML-shaped but not YAML (portfolio-ops #75), so this
// stays a line parser. It must still honour the two YAML features the files
// use (#181): a trailing ` # comment`, and quoted values, which portfolio-ops
// D-010 now *requires* in `related_issues` (`["#201", "#129"]`). Reading the raw
// text kept both: `reversibility: cheap   # ...` parsed as "unknown", and
// `["#201", "#129"]   # quoted per ...` became one garbage element. Measured
// over the 13 repos' files: 73 of 231 decisions came back corrupted. And
// `superseded_by: null  # still active` would have read as superseded.

/**
 * Cut a ` #` comment that starts outside quotes AND outside `[...]`.
 *
 * Strict YAML would also cut inside a flow list, but these files predate
 * D-010's quoting rule and write `related_issues: [#48, #50]`, which this
 * parser has always read as two issues. Keeping that working is why `#` inside
 * brackets is never a comment here.
 */
function stripTrailingComment(raw: string): string {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "#" && depth === 0 && (i === 0 || /\s/.test(raw[i - 1] ?? ""))) {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

/** Remove one layer of matching YAML quotes, honouring their escapes. */
function unquote(v: string): string {
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** Split a flow-list body on commas that sit outside quotes. */
function splitFlowList(inner: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out;
}

/**
 * `comments: false` is for the free-text fields (`decision`, `rationale`):
 * prose like "fixes #12 and #13" is a value, not a comment, and no file puts
 * a comment after prose. Structured fields strip them.
 */
function parseScalar(raw: string, { comments = true }: { comments?: boolean } = {}): string | null {
  const v = comments ? stripTrailingComment(raw) : raw.trim();
  // Bare `null` / `~` only: a quoted "null" is the string, as in YAML.
  if (v === "" || v === "null" || v === "~") return null;
  return unquote(v);
}

function parseList(raw: string): string[] {
  const v = stripTrailingComment(raw);
  if (v === "" || v === "[]" || v === "null" || v === "~") return [];
  const m = v.match(/^\[(.*)\]$/);
  if (!m) return [unquote(v)];
  const inner = m[1] ?? "";
  if (inner.trim() === "") return [];
  return splitFlowList(inner)
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

function parseReversibility(raw: string | null): CoreDecision["reversibility"] {
  switch (raw) {
    case "cheap":
    case "expensive":
    case "one-way":
      return raw;
    default:
      return "unknown";
  }
}

export function parseCoreDecisionsMarkdown(text: string): CoreDecision[] {
  const lines = text.split(/\r?\n/);
  const decisions: CoreDecision[] = [];
  let current: Partial<CoreDecision> | null = null;

  const flush = () => {
    if (current && typeof current.id === "string" && current.id.length > 0) {
      decisions.push({
        id: current.id,
        date: current.date ?? null,
        decision: current.decision ?? null,
        rationale: current.rationale ?? null,
        alternatives_rejected: current.alternatives_rejected ?? [],
        reversibility: current.reversibility ?? "unknown",
        related_issues: current.related_issues ?? [],
        superseded_by: current.superseded_by ?? null,
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (COMMENT_LINE.test(line)) continue;
    const idMatch = line.match(ID_LINE);
    if (idMatch) {
      const id = idMatch[1];
      if (typeof id !== "string" || id.length === 0) continue;
      flush();
      current = { id };
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(KV_LINE);
    if (!kvMatch) continue;
    const key = kvMatch[1] as string;
    const value = kvMatch[2] ?? "";
    switch (key) {
      case "date":
        current.date = parseScalar(value);
        break;
      case "decision":
      case "rationale":
        current[key] = parseScalar(value, { comments: false }) as never;
        break;
      case "reversibility":
        current.reversibility = parseReversibility(parseScalar(value));
        break;
      case "alternatives_rejected":
      case "related_issues":
        current[key] = parseList(value);
        break;
      case "superseded_by":
        current.superseded_by = parseScalar(value);
        break;
      default:
        break;
    }
  }
  flush();
  return decisions;
}

export function decisionsFilePath(portfolioRoot: string, repo: string): string {
  // Strip anything outside the slug allow-list, then reject if anything was
  // stripped. The hyphen is last in the class (a literal, no escape needed);
  // a stray `\\` here previously whitelisted backslash, letting a Windows-style
  // separator (`..\\..\\secret`) slip past this trust boundary.
  const safeRepo = repo.replace(/[^A-Za-z0-9_.-]/g, "");
  if (safeRepo !== repo) {
    throw new Error(`invalid repo name: ${repo}`);
  }
  // `.` and `-` are in the allow-list above, so a bare `.` or `..` survives the
  // strip unchanged (safeRepo === repo) and slips past it — then `path.join`
  // collapses the `..` and the lookup escapes the `repos/` jail (e.g.
  // `repos/../MEMORY/...` -> `<root>/MEMORY/...`). Reject these two segment
  // names explicitly: they are never valid repo slugs, so this is fail-closed
  // and rejects only categorically-invalid input (a literal `...` directory is
  // still allowed). Same trust-boundary class as the backslash gap above.
  if (repo === "." || repo === "..") {
    throw new Error(`invalid repo name: ${repo}`);
  }
  if (repo === "portfolio-ops") {
    return path.join(portfolioRoot, "portfolio-ops", "MEMORY", "core_decisions_ai.md");
  }
  return path.join(portfolioRoot, "repos", repo, "MEMORY", "core_decisions_ai.md");
}

export async function readCoreDecisions(
  portfolioRoot: string,
  repo: string,
): Promise<{ repo: string; source: string; decisions: CoreDecision[] }> {
  const file = decisionsFilePath(portfolioRoot, repo);
  const text = await readFile(file, "utf8");
  return {
    repo,
    source: file,
    decisions: parseCoreDecisionsMarkdown(text),
  };
}
