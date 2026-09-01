/**
 * Every `process.env` read goes through `src/io/env.ts` (#131), enforced by
 * parsing rather than by scanning text (#135).
 *
 * `#124` fixed the blank-but-truthy class and recorded its scope as a prose
 * list of four sites. There were six. A comment cannot enforce a population and
 * a hand-written list cannot see a new member, so the count is discovered here.
 *
 * The *discovery* was right from the start; the *predicate* was not. It asked
 * whether a file mentioned an env helper anywhere in its text, which an
 * `import` alone satisfies. Measured (#135): reverting `src/bin/trace-server.ts`
 * to `Number(process.env.PORT) || DEFAULT_PORT` while leaving
 * `import { resolvePort } from "../io/env.js"` at the top left this file at
 * **6 of 6 passing** — the exact regression it exists to catch. (`port-env.test.ts`
 * caught it, because #132 hand-wrote a lock for that one site. That works and
 * does not scale: it is one lock per call site, which is the
 * hand-written-list problem this file was created to avoid, one level down.)
 *
 * The rule it was trying to state is "the value reaches a helper", and text
 * matching cannot see whether a value flows anywhere. So it is stated on the
 * AST instead. `typescript` is already a devDependency — it is what
 * `npm run typecheck` runs — so the exact rule costs no new dependency, which
 * was the only reason #135 hedged toward an approximate one.
 *
 * A `process.env` node passes if either:
 *
 *  1. it sits inside the **argument subtree** of a call to an env helper.
 *     Every ancestor is considered, not just the nearest call:
 *     `src/eval/comment.ts` reads it inside an arrow function inside `.map()`
 *     inside an array inside the `firstNonBlank(...)` call, and stopping at the
 *     first `CallExpression` would flag correct code.
 *  2. it is the **initializer of a parameter typed `NodeJS.ProcessEnv`** — the
 *     dependency-injection seam `src/io/env.ts` uses three times.
 *
 * Reaching a call through its callee rather than its arguments does not count.
 *
 * Clause 2 replaces a `DELIBERATE_DIRECT_READERS` set that named
 * `src/io/env.ts` by path. Deriving the exemption from what the code *does*
 * beats naming the file: a second module adopting the same seam is covered, a
 * module that abandons the seam stops being covered, and nobody maintains a
 * list. That set previously held a second entry — `src/bin/trace-server.ts`,
 * excused because "`Number(...) || default` has no blank-but-truthy hazard,
 * since `Number("  ")` is `0`". Every word of that was true, and it excused the
 * site while a different defect sat in the same expression (#132). A *true*
 * reason for an exclusion is harder to spot than a false one, because
 * re-reading confirms it.
 *
 * Not modelled, deliberately: data flow across a variable binding
 * (`const x = process.env.Y; helper(x)`). No site writes it, and inventing a
 * one-hop alias analysis for a shape nobody uses is how a lint rule starts
 * lying. Such a site would fail loudly here with its line named — the right
 * failure, and better than the old rule's silence.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** Directories that ship runtime code. `test/` legitimately manipulates env. */
const SOURCE_DIRS = ["src", "mcp-server"] as const;

/** The helpers that make a `process.env` read safe. */
const ENV_HELPERS = new Set([
  "firstNonBlankEnv",
  "firstNonBlank",
  "resolvePortfolioRoot",
  "resolveIntEnv",
  "resolvePort",
]);

/** The parameter type that marks the dependency-injection seam. */
const ENV_PARAM_TYPE = "NodeJS.ProcessEnv";

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Strip comments, for the *text* assertions in the outcome pin below.
 *
 * The rule itself no longer needs this — a parser never sees a comment, which
 * is why the prose in `src/bin/trace-server.ts` quoting
 * `Number(process.env.PORT) || 8766` stops being a special case. It survives
 * only where an assertion is genuinely about text, e.g. "this file no longer
 * contains the old guard shape", where a comment recording that shape must not
 * count as having it.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function parse(fileName: string, source: string): ts.SourceFile {
  // `setParentNodes: true` is what makes the ancestor walk below possible.
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

/** Is this node the `process.env` member expression itself? */
function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env"
  );
}

/** The called function's name, for both `f(...)` and `obj.f(...)`. */
function calleeName(call: ts.CallExpression): string {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return "";
}

/** Does this `process.env` node's value reach a helper, or is it the DI seam? */
function isGuarded(envNode: ts.Node): boolean {
  let child: ts.Node = envNode;
  let parent: ts.Node | undefined = envNode.parent;
  while (parent) {
    if (ts.isCallExpression(parent)) {
      // Only an *argument* counts. Arriving via `parent.expression` means the
      // read is in the callee, which the helper never sees.
      const isArgument = parent.arguments.some((a) => a === child);
      if (isArgument && ENV_HELPERS.has(calleeName(parent))) return true;
    }
    if (ts.isParameter(parent) && parent.initializer === child) {
      const typeText = parent.type ? parent.type.getText(parent.getSourceFile()) : "";
      if (typeText === ENV_PARAM_TYPE) return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

interface EnvRead {
  readonly file: string;
  readonly line: number;
  readonly guarded: boolean;
}

/** Every `process.env` node in a source string, with its verdict. */
function envReadsIn(fileName: string, source: string): EnvRead[] {
  const sf = parse(fileName, source);
  const out: EnvRead[] = [];
  const visit = (node: ts.Node): void => {
    if (isProcessEnv(node)) {
      out.push({
        file: fileName,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        guarded: isGuarded(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function allEnvReads(): EnvRead[] {
  const out: EnvRead[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of tsFilesUnder(join(REPO_ROOT, dir))) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      out.push(...envReadsIn(rel, readFileSync(file, "utf8")));
    }
  }
  return out;
}

const unguarded = (reads: EnvRead[]): string[] =>
  reads.filter((r) => !r.guarded).map((r) => `${r.file}:${r.line}`).sort();

describe("env-read population", () => {
  it("finds source files to check at all", () => {
    // Anti-vacuous: an empty offender list is the pass condition below, and a
    // broken walk produces one too.
    const files = SOURCE_DIRS.flatMap((d) => tsFilesUnder(join(REPO_ROOT, d)));
    expect(files.length).toBeGreaterThan(10);
  });

  it("every env read routes through src/io/env.ts", () => {
    expect(unguarded(allEnvReads())).toEqual([]);
  });

  it("the walk actually reaches env-reading files", () => {
    // Anti-vacuous for the rule above. These two read `process.env` on purpose,
    // to thread an explicit option ahead of the environment, and hand the
    // result to `firstNonBlank` — so they are the proof the parse sees
    // anything at all, and the proof clause 1 accepts a legitimate read.
    const files = new Set(allEnvReads().map((r) => r.file));
    expect(files).toContain("src/eval/comment.ts");
    expect(files).toContain("src/trace/pg-store.ts");
    expect(files).toContain("src/io/env.ts");
    expect(allEnvReads().length).toBeGreaterThanOrEqual(3);
  });

  it("the DI-seam clause is load-bearing, not decoration", () => {
    // Replaces the old `DELIBERATE_DIRECT_READERS` existence check. That set
    // asserted a named file still read env; this asserts the *derived*
    // exemption is actually carrying something — if `src/io/env.ts` stopped
    // using the `NodeJS.ProcessEnv` parameter seam, clause 2 would be dead code
    // and nothing else would say so.
    const reads = envReadsIn("src/io/env.ts", readFileSync(join(REPO_ROOT, "src/io/env.ts"), "utf8"));
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.every((r) => r.guarded)).toBe(true);
  });

  it("both #131 sites resolve PORTFOLIO_ROOT through the shared helper", () => {
    // The outcome, pinned directly. These two have no `process.env` node at all
    // — which is the fix — so the rule above cannot be what keeps them honest.
    // One reads it under `mcp-server/`, the directory #124's scope never
    // covered.
    for (const rel of [
      "src/tools/get-portfolio-context.ts",
      "mcp-server/portfolio-context/bin.ts",
    ]) {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      const code = stripComments(source);
      expect(code, `${rel} should call resolvePortfolioRoot`).toMatch(/resolvePortfolioRoot\(/);
      // The env-read assertion needs no stripping: it parses.
      expect(envReadsIn(rel, source), `${rel} should not read process.env`).toEqual([]);
      expect(code, `${rel} still has the blank-but-truthy guard`).not.toMatch(/\.length === 0/);
    }
  });
});

// (label, source, expected offending-line count). Both directions over
// constructed input, so a broken rule cannot pass by flagging nothing or by
// flagging everything (#135's third acceptance criterion).
const CASES: ReadonlyArray<readonly [string, string, number]> = [
  [
    "THE HALF-REVERT: helper imported, call site reverted",
    `import { resolvePort } from "../io/env.js";
     const DEFAULT_PORT = 8766;
     const port = Number(process.env.PORT) || DEFAULT_PORT;`,
    1,
  ],
  [
    "the same file after the real fix",
    `import { resolvePort } from "../io/env.js";
     const port = resolvePort(8766);`,
    0,
  ],
  ["a bare unguarded read", 'const root = process.env["PORTFOLIO_ROOT"];', 1],
  ["a direct helper argument", 'const root = firstNonBlankEnv(["PORTFOLIO_ROOT"], process.env);', 0],
  [
    "pg-store's shape: inside an array argument",
    'const cs = firstNonBlank([this.opts.connectionString, process.env.DATABASE_URL], DEFAULT);',
    0,
  ],
  [
    "comment.ts's shape: arrow inside map inside array inside the call",
    'const t = firstNonBlank([opts.token, ...NAMES.map((n) => process.env[n])], "");',
    0,
  ],
  [
    "env.ts's shape: NodeJS.ProcessEnv parameter default",
    "export function f(names: string[], env: NodeJS.ProcessEnv = process.env): string { return ''; }",
    0,
  ],
  [
    "a parameter default WITHOUT the ProcessEnv type is not the seam",
    "export function f(env = process.env): string { return ''; }",
    1,
  ],
  [
    "a parameter default typed as something else is not the seam",
    "export function f(env: Record<string, string> = process.env): string { return ''; }",
    1,
  ],
  ["a mention in a line comment", "// was: const root = process.env.PORTFOLIO_ROOT;", 0],
  ["a mention in a block comment", "/* Number(process.env.PORT) || 8766 */ const x = 1;", 0],
  ["a mention in a string literal", 'const doc = "reads process.env.PORT directly";', 0],
  [
    "escaping into a local binding is NOT credited",
    "const raw = process.env.PORT; const port = resolvePort(raw);",
    1,
  ],
  [
    "two unguarded reads are two findings",
    "const a = process.env.A; const b = process.env.B;",
    2,
  ],
  [
    "guarded and unguarded in one file: the guarded one does not launder the other",
    'const a = firstNonBlank([process.env.A], ""); const b = process.env.B;',
    1,
  ],
];

describe("the rule, over constructed input", () => {
  it("the case table covers both verdicts", () => {
    // Anti-vacuous: a table that drifted to all-clean or all-offending would
    // make every row below pass while proving nothing.
    expect(CASES.filter(([, , n]) => n > 0).length).toBeGreaterThanOrEqual(6);
    expect(CASES.filter(([, , n]) => n === 0).length).toBeGreaterThanOrEqual(6);
  });

  it.each(CASES)("%s", (label, source, expected) => {
    const reads = envReadsIn("probe.ts", source);
    expect(reads.filter((r) => !r.guarded)).toHaveLength(expected);
  });

  it("the old text rule passes the half-revert, which is why this one parses", () => {
    // The measured regression from #135, kept as a row so the reason for the
    // rewrite survives the rewrite. A file-level "does the text mention a
    // helper" test is satisfied by the import alone.
    const halfRevert = `import { resolvePort } from "../io/env.js";
      const port = Number(process.env.PORT) || DEFAULT_PORT;`;
    const oldTextRule = (code: string): boolean =>
      /process\.env/.test(code) &&
      ![...ENV_HELPERS].some((h) => new RegExp(`\\b${h}\\b`).test(code));

    expect(oldTextRule(halfRevert)).toBe(false); // blind, as measured
    expect(envReadsIn("probe.ts", halfRevert).filter((r) => !r.guarded)).toHaveLength(1);
  });

  it("reports the line, not just the file", () => {
    // A file-level verdict cannot point at which of several reads is wrong,
    // and this rule's whole premise is that a file can hold both kinds.
    const source = ['const ok = firstNonBlank([process.env.A], "");', "", "const bad = process.env.B;"].join(
      "\n",
    );
    const offenders = envReadsIn("probe.ts", source).filter((r) => !r.guarded);
    expect(offenders).toHaveLength(1);
    expect(offenders.map((r) => r.line)).toEqual([3]);
  });
});
