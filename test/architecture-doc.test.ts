// Architecture-doc lock: catch drift between docs/architecture.md and
// the actual shipped surface of the repo.
//
// Sister to the architecture-doc locks shipped this same week in
// `nextjs-streaming-ai-patterns` PR #19, `ai-app-integration-tests`
// PR #19, `mcp-server-cookbook` PR #23, and the Python sisters
// `embedding-model-shootout` PR #20, `vector-search-at-scale` PR #22,
// `llm-eval-harness` PR #30, `prompt-regression-suite` PR #25,
// `llm-cost-optimizer` PR #28, `rag-production-kit` PR #30,
// `chunking-strategies-lab` PR #22, `python-async-llm-pipelines` PR #25.
//
// This doc uses BOTH (#NN) issue references AND D-NNN core-decision
// references, so coverage is dual-axis. Before issue #23, six section
// headers carried `this PR — issue #NN` framing and two paragraphs said
// `deliberately not in this PR` for surfaces that had since shipped.
// This test locks against that re-drifting plus catches the inverse
// drift (someone deletes a shipped layer's section).
//
// Four invariants pinned:
//
//   1. Path-token reachability: every backtick-quoted token starting
//      with one of RESOLVABLE_PREFIXES resolves on disk. Operator-
//      supplied future artifacts allow-listed in
//      OPERATOR_SUPPLIED_PATHS. Placeholder shapes <...>, {...}, glob
//      `*` are skipped as templates.
//
//   2. Closed-feature-issue coverage: every issue in
//      KNOWN_SHIPPED_ISSUES is referenced at least once.
//
//   3. Active-decision coverage: every non-superseded D-NNN >= 2 in
//      MEMORY/core_decisions_ai.md is referenced at least once.
//
//   4. Banned-phrase absence: the drift shapes the pre-#23 doc carried
//      ("this pr", "pending downstream", etc.), case-insensitive.
//
// Five hard-pin tests lock BANNED_PHRASES, RESOLVABLE_PREFIXES,
// KNOWN_SHIPPED_ISSUES, MIN_ACTIVE_DECISION_ID, and
// OPERATOR_SUPPLIED_PATHS so a future loose edit can't silently weaken
// the guard.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const DOC_PATH = resolve(REPO_ROOT, "docs/architecture.md");
const DECISIONS_PATH = resolve(REPO_ROOT, "MEMORY/core_decisions_ai.md");

const BANNED_PHRASES = [
  "this pr",
  "pending downstream",
  "(unfiled)",
  "to-be-filed",
] as const;

const RESOLVABLE_PREFIXES = [
  "src/",
  "test/",
  "infra/",
  "mcp-server/",
  "fixtures/",
  "scripts/",
  "docs/",
  ".github/",
] as const;

// Operator-supplied artifacts: paths the doc names as the file an
// operator commits after a real workload. Empty by default; populated
// only if authoring uncovers a legitimate operator-only path.
const OPERATOR_SUPPLIED_PATHS: ReadonlyArray<string> = [];

// Core deliverables (handoff §2). Each shipped surface is annotated in
// the doc with its origin issue number.
const KNOWN_SHIPPED_ISSUES = [1, 2, 3, 4, 5, 6, 7, 39] as const;

const MIN_ACTIVE_DECISION_ID = 2;

function readDoc(): string {
  return readFileSync(DOC_PATH, "utf-8");
}

function readDecisions(): string {
  return readFileSync(DECISIONS_PATH, "utf-8");
}

function activeDecisions(): ReadonlyArray<number> {
  const text = readDecisions();
  // Blocks separated by `- id: D-NNN` lines. Capture id + superseded_by.
  const blocks = text.split(/\n(?=- id:)/);
  const out: number[] = [];
  for (const block of blocks) {
    const idMatch = block.match(/- id:\s*D-(\d+)/);
    if (!idMatch || idMatch[1] === undefined) continue;
    const supMatch = block.match(/superseded_by:\s*(\S+)/);
    const supValue = supMatch?.[1];
    const isActive =
      supValue === undefined || supValue.trim().toLowerCase() === "null";
    if (isActive) {
      const n = Number.parseInt(idMatch[1], 10);
      if (n >= MIN_ACTIVE_DECISION_ID) out.push(n);
    }
  }
  return out.slice().sort((a, b) => a - b);
}

function extractBacktickPaths(text: string): Set<string> {
  const found = new Set<string>();
  // Backtick-spans only. Skip multi-line code fences (` ``` `).
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const captured = m[1];
    if (captured === undefined) continue;
    let token = captured.trim();
    let matched: string | undefined;
    for (const prefix of RESOLVABLE_PREFIXES) {
      if (token.startsWith(prefix)) {
        matched = prefix;
        break;
      }
    }
    if (!matched) continue;
    // Drop trailing punctuation.
    while (token.length > 0 && ".,;:".includes(token[token.length - 1]!)) {
      token = token.slice(0, -1);
    }
    // Drop trailing `()` from function-style refs.
    token = token.replace(/\(\)$/, "");
    // Skip placeholder shapes: `<var>` / `{a,b}` / glob `*`.
    if (token.includes("<") || token.includes("{") || token.includes("*")) {
      continue;
    }
    if (token.length > 0) found.add(token);
  }
  return found;
}

function resolvesOnDisk(token: string): boolean {
  return existsSync(resolve(REPO_ROOT, token));
}

describe("architecture-doc", () => {
  it("doc file exists", () => {
    expect(existsSync(DOC_PATH)).toBe(true);
  });

  it("decisions file exists", () => {
    expect(existsSync(DECISIONS_PATH)).toBe(true);
  });

  it("every backtick path token resolves on disk", () => {
    const tokens = extractBacktickPaths(readDoc());
    const operatorSet = new Set<string>(OPERATOR_SUPPLIED_PATHS);
    const unresolved = [...tokens]
      .filter((t) => !resolvesOnDisk(t) && !operatorSet.has(t))
      .sort();
    expect(
      unresolved,
      "docs/architecture.md quotes paths that don't exist on disk. " +
        "Regenerate the doc to match the current layout, fix the typo, " +
        "or — if this is an operator-supplied future artifact — add it " +
        "to OPERATOR_SUPPLIED_PATHS in test/architecture-doc.test.ts."
    ).toEqual([]);
  });

  it("operator-supplied paths are actually absent on disk", () => {
    const landed = OPERATOR_SUPPLIED_PATHS.filter((p) => resolvesOnDisk(p));
    expect(
      landed,
      "Paths listed as operator-supplied exist on disk; drop them " +
        "from OPERATOR_SUPPLIED_PATHS so the resolvability check " +
        "covers them as literal paths."
    ).toEqual([]);
  });

  it("every shipped feature-issue is referenced", () => {
    const text = readDoc();
    const referenced = new Set<number>();
    for (const m of text.matchAll(/#(\d+)\b/g)) {
      referenced.add(Number.parseInt(m[1]!, 10));
    }
    const missing = KNOWN_SHIPPED_ISSUES.filter((n) => !referenced.has(n));
    expect(
      missing,
      "docs/architecture.md doesn't reference these shipped feature-issues. " +
        "Every shipped layer should be annotated with its origin (#NN) " +
        "in the relevant section or diagram node."
    ).toEqual([]);
  });

  it("every active core decision is referenced", () => {
    const text = readDoc();
    const referenced = new Set<number>();
    for (const m of text.matchAll(/\bD-0*(\d+)\b/g)) {
      referenced.add(Number.parseInt(m[1]!, 10));
    }
    const missing = activeDecisions().filter((n) => !referenced.has(n));
    expect(
      missing,
      "docs/architecture.md doesn't reference these active " +
        "(non-superseded) core decisions even once. Every D-NNN in " +
        "MEMORY/core_decisions_ai.md should be cited in the doc where " +
        "the relevant code lives."
    ).toEqual([]);
  });

  it("contains no banned drift phrases", () => {
    const lowered = readDoc().toLowerCase();
    const hits = BANNED_PHRASES.filter((p) => lowered.includes(p));
    expect(
      hits,
      "docs/architecture.md contains drift phrases. These describe a " +
        "pre-shipping state; the doc is a steady-state reference, not a " +
        "PR description."
    ).toEqual([]);
  });

  it("BANNED_PHRASES is hard-pinned", () => {
    expect([...BANNED_PHRASES]).toEqual([
      "this pr",
      "pending downstream",
      "(unfiled)",
      "to-be-filed",
    ]);
  });

  it("RESOLVABLE_PREFIXES is hard-pinned", () => {
    expect([...RESOLVABLE_PREFIXES]).toEqual([
      "src/",
      "test/",
      "infra/",
      "mcp-server/",
      "fixtures/",
      "scripts/",
      "docs/",
      ".github/",
    ]);
  });

  it("KNOWN_SHIPPED_ISSUES is hard-pinned", () => {
    expect([...KNOWN_SHIPPED_ISSUES]).toEqual([1, 2, 3, 4, 5, 6, 7, 39]);
  });

  it("MIN_ACTIVE_DECISION_ID is hard-pinned", () => {
    expect(MIN_ACTIVE_DECISION_ID).toBe(2);
  });

  it("OPERATOR_SUPPLIED_PATHS is hard-pinned", () => {
    expect([...OPERATOR_SUPPLIED_PATHS]).toEqual([]);
  });
});
