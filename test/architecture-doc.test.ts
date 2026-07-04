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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

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

// ---------------------------------------------------------------------------
// Symbol-resolution lock (portfolio-ops #55, TS side — #87).
//
// The four invariants above lock path tokens, shipped issues, active
// decisions, and banned phrases — but nothing checks that the *symbols* the
// doc names actually exist. This doc has the richest symbol vocabulary of any
// TS repo in the portfolio: types (`AgentRun`, `AnthropicPlanner`, `PgStore`,
// `TraceStore`, `ReplanReason`, ...) and functions/methods (`aggregateCost`,
// `buildDefaultRegistry`, `runStepWithRetryAndFallback`, `scoreReview`,
// `getRun`/`listRuns`/`writeRun`, ...). A rename would leave the doc stale with
// CI green — the drift class portfolio-ops #55 catalogued portfolio-wide (e.g.
// llm-cost-optimizer's nonexistent `BatchAPIBackend`).
//
// Same resolver shape as the nextjs-streaming-ai-patterns #77 /
// ai-app-integration-tests #73 siblings (multi-word camel/Pascal candidates,
// fenced blocks stripped), with one adaptation this doc forces: the ground
// truth includes **method declarations**, not just top-level ones — the doc
// names store/planner/executor methods (`getRun`, `writeRun`, `initialPlan`,
// `runStepWithRetryAndFallback`) that aren't module-level functions. Three
// hard-pinned exception sets carry the non-declaration identifiers.

const SYMBOL_SOURCE_DIRS = ["src", "mcp-server", "scripts"] as const;

// npm package.json vocabulary the doc names in backticks (the pg driver is
// declared as an optionalDependency so hermetic CI doesn't pull it). Not repo
// symbols. Hard-pinned below.
const EXTERNAL_SYMBOLS: ReadonlyArray<string> = [
  "optionalDependencies",
  "optionalDependency",
] as const;

// Documented-future symbols the doc forward-references. `AnthropicPlanner` is
// the not-yet-shipped production planner: src/agent/planner.ts calls it
// "(separate file, future)", src/eval/runner.ts says "Once AnthropicPlanner
// lands", and the doc says a `ScriptedPlanner` placeholder "swaps in here".
// Kept semantically distinct from EXTERNAL_SYMBOLS so the pin self-documents
// that this names an intended-but-unshipped surface; drop it once the class
// lands (at which point it also resolves as a real declaration).
const PLANNED_SYMBOLS: ReadonlyArray<string> = ["AnthropicPlanner"] as const;

// Object-field / option-key names the doc references that are neither
// top-level nor method declarations. `toolName` is an object field
// (src/tools/registry.ts); `fallbackTo` is the fallback option-key surfaced in
// the executor's error message. Kept as explicit, verified pins rather than
// broadening the ground truth to all `NAME:` property keys (which would weaken
// the lock into "identifier appears anywhere in source").
const DOC_FIELDS: ReadonlyArray<string> = ["fallbackTo", "toolName"] as const;

// Reserved words that can appear as `NAME(` at the start of an indented line
// but are control flow, not method declarations.
const NON_METHOD_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "constructor",
  "await",
  "typeof",
  "do",
  "else",
]);

/** Strip fenced code blocks (``` ... ```), including mermaid diagrams and the
 *  directory tree, so backtick pairing for inline-code extraction can't desync
 *  on the triple fences. */
function stripFences(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "");
}

/** True for a multi-word camelCase or PascalCase identifier. */
function isMultiWordIdentifier(tok: string): boolean {
  return /[a-z][A-Z]/.test(tok) || /[A-Z][a-z].*[A-Z]/.test(tok);
}

/** Multi-word camel/Pascal identifier candidates from the doc. */
function candidateSymbols(md: string): string[] {
  const prose = stripFences(md);
  const out = new Set<string>();
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    for (const piece of m[1]!.split(/[^A-Za-z0-9_$]+/)) {
      for (const tok of piece.split(".")) {
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tok) && isMultiWordIdentifier(tok)) {
          out.add(tok);
        }
      }
    }
  }
  return [...out].sort();
}

/** Recursively collect `*.ts` files (excluding tests) under a source dir. */
function sourceFiles(dir: string): string[] {
  const abs = resolve(REPO_ROOT, dir);
  if (!existsSync(abs)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(rel));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(resolve(REPO_ROOT, rel));
    }
  }
  return files;
}

/** Ground truth: every top-level declaration AND class/interface method
 *  declaration across the source dirs. Methods are load-bearing here — the doc
 *  names store/planner methods that aren't module-level functions. Method
 *  extraction matches an indented `NAME(params)` followed by a return-type
 *  annotation or a `{` body (so plain calls, which lack the trailing `{`/`:`,
 *  are not counted), minus control-flow keywords. */
function repoDeclaredSymbols(): Set<string> {
  const declRe =
    /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:function\*?|const|let|var|class|type|interface|enum)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const methodRe =
    /(?:^|\n)[ \t]+(?:(?:public|private|protected|static|readonly|async|get|set|override|abstract)[ \t]+)*([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\([^)]*\)[ \t]*(?::[^\n{]*)?\{/g;
  const names = new Set<string>();
  for (const dir of SYMBOL_SOURCE_DIRS) {
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(declRe)) names.add(m[1]!);
      for (const m of text.matchAll(methodRe)) {
        if (!NON_METHOD_KEYWORDS.has(m[1]!)) names.add(m[1]!);
      }
    }
  }
  return names;
}

/** Shared resolution path used by both the live and inverse tests. */
function unresolvedSymbols(md: string, repoSymbols: Set<string>): string[] {
  const allowed = new Set<string>([...EXTERNAL_SYMBOLS, ...PLANNED_SYMBOLS, ...DOC_FIELDS]);
  return candidateSymbols(md).filter(
    (sym) => !repoSymbols.has(sym) && !allowed.has(sym),
  );
}

describe("docs/architecture.md names only symbols that exist (#87 / portfolio-ops #55)", () => {
  const md = readFileSync(DOC_PATH, "utf8");
  const repoSymbols = repoDeclaredSymbols();

  it("extracts a non-empty candidate set (guards regex/extraction breakage)", () => {
    expect(candidateSymbols(md).length).toBeGreaterThan(0);
  });

  it("discovers the repo's real declarations and methods as ground truth", () => {
    // Sanity floor: a top-level type, a top-level fn, and a store method — all
    // named in the doc. If the scan regresses, the resolution test would
    // false-flag everything; catch it here with a legible message.
    for (const known of ["TraceStore", "buildDefaultRegistry", "writeRun"]) {
      expect(repoSymbols.has(known), `expected repo symbol '${known}' in the source scan`).toBe(true);
    }
  });

  it("every multi-word symbol the doc names resolves to a declaration or a pinned exception", () => {
    const unresolved = unresolvedSymbols(md, repoSymbols);
    expect(
      unresolved,
      `docs/architecture.md names these multi-word identifiers that resolve to no ` +
        `top-level or method declaration in ${JSON.stringify([...SYMBOL_SOURCE_DIRS])}, ` +
        `and are not in EXTERNAL_SYMBOLS / PLANNED_SYMBOLS / DOC_FIELDS: ` +
        `${JSON.stringify(unresolved)}. Fix the doc, or add the symbol to the matching pinned set.`,
    ).toEqual([]);
  });

  it("flags an injected drifted symbol while a real one in the same text resolves (inverse safety net)", () => {
    // `writeRunXYZ` is not a declaration/method/pin; `writeRun` is a real store
    // method. Same code path as the live test, so the green can't be vacuous.
    const injected = "the real `writeRun` sits beside a drifted `writeRunXYZ`";
    const unresolved = unresolvedSymbols(injected, repoSymbols);
    expect(unresolved).toContain("writeRunXYZ");
    expect(unresolved).not.toContain("writeRun");
  });

  it("EXTERNAL_SYMBOLS is the exact pinned set", () => {
    expect([...EXTERNAL_SYMBOLS]).toEqual(["optionalDependencies", "optionalDependency"]);
  });

  it("PLANNED_SYMBOLS is the exact pinned set", () => {
    expect([...PLANNED_SYMBOLS]).toEqual(["AnthropicPlanner"]);
  });

  it("DOC_FIELDS is the exact pinned set", () => {
    expect([...DOC_FIELDS]).toEqual(["fallbackTo", "toolName"]);
  });

  it("SYMBOL_SOURCE_DIRS is the exact pinned set", () => {
    expect([...SYMBOL_SOURCE_DIRS]).toEqual(["src", "mcp-server", "scripts"]);
  });
});
