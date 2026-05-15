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

function parseScalar(raw: string): string | null {
  const v = raw.trim();
  if (v === "" || v === "null" || v === "~") return null;
  return v;
}

function parseList(raw: string): string[] {
  const v = raw.trim();
  if (v === "" || v === "[]") return [];
  const m = v.match(/^\[(.*)\]$/);
  if (!m) return [v];
  const inner = m[1] ?? "";
  if (inner.trim() === "") return [];
  return inner
    .split(",")
    .map((s) => s.trim())
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
      case "decision":
      case "rationale":
        current[key] = parseScalar(value) as never;
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
  const safeRepo = repo.replace(/[^A-Za-z0-9_.\\-]/g, "");
  if (safeRepo !== repo) {
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
