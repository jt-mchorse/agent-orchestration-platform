/**
 * Public-surface tests for `src/index.ts`.
 *
 * The package's public surface re-exports ~50 names from five
 * directories (`tools/`, `agent/`, `trace/`, `ui/`, `eval/`). Every
 * other test in this suite imports submodules directly (`from
 * "../src/eval/comment.js"`), so silent renames or accidental drops
 * in `src/index.ts` don't fail any test — but they break the README's
 * two quoted `import { ... } from "./src/index.js"` snippets and the
 * `portfolio-context-mcp` `bin` entry-point.
 *
 * Four orthogonal axes, adapted from the Python `tests/test_public_surface.py`
 * pattern landed across `llm-eval-harness`, `llm-cost-optimizer`,
 * `prompt-regression-suite`, `rag-production-kit`, `embedding-model
 * -shootout`, `chunking-strategies-lab`, `python-async-llm-pipelines`,
 * `mcp-server-cookbook` (filesystem-sandbox-py), and `vector-search-at-scale`:
 *
 * 1. `package.json#version` is set to a semver-ish string (the TS
 *    analog of `__version__`).
 * 2. Every value export from `src/index.ts` is defined and non-null
 *    at runtime (`Object.keys(import * as Index)` analog of `__all__`
 *    bound-and-non-None).
 * 3. The README's quoted import names resolve on the index module
 *    (analog of `test_readme_quickstart_imports_resolve`).
 * 4. `package.json#bin.portfolio-context-mcp` maps to a real
 *    pre-build source file at the expected location. CI's `test` job
 *    runs `npm test` without `npm run build`, so verifying the
 *    `dist/...` output would require an extra build step; instead we
 *    verify the source-of-truth file the build emits from (analog of
 *    `test_console_script_dotted_path_resolves`).
 *
 * Type-only exports (`export type { ... }`) are intentionally NOT
 * checked here — they don't exist at runtime, so `Object.keys` won't
 * see them and asserting on them would require AST parsing. Future
 * iteration if drift in type exports proves to be a real failure mode.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import * as Index from "../src/index.js";

const ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

// README's two quoted `import { ... } from "./src/index.js"` snippets
// (lines 73 and 119-123 in README.md) name these three values between
// them. If any disappear from the index module, every reader who
// copy-pastes a snippet hits an ImportError equivalent.
const README_QUICKSTART_NAMES = [
  "buildDefaultRegistry",
  "createCliApprovalProvider",
  "autoApproveProvider",
] as const;

interface PackageJson {
  readonly version?: unknown;
  readonly bin?: Record<string, unknown>;
}

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;
}

describe("public surface — package.json#version", () => {
  it("is set to a semver-ish string", () => {
    const pkg = loadPackageJson();
    expect(pkg.version, "package.json#version is missing").toBeDefined();
    expect(
      typeof pkg.version,
      `package.json#version should be a string, got ${typeof pkg.version}`,
    ).toBe("string");
    const version = pkg.version as string;
    expect(version, "package.json#version is empty").not.toBe("");
    expect(
      SEMVER_PATTERN.test(version),
      `package.json#version = ${JSON.stringify(version)} doesn't look like semver`,
    ).toBe(true);
  });
});

describe("public surface — src/index.ts value exports", () => {
  it("every value export resolves to a defined, non-null binding", () => {
    // `import * as Index` only surfaces VALUE exports (functions,
    // classes, consts). `export type { ... }` is erased at runtime
    // and intentionally out of scope here.
    const names = Object.keys(Index).filter((name) => name !== "default");
    expect(
      names.length,
      "src/index.ts re-exports no value names? — likely an import-path regression",
    ).toBeGreaterThan(0);

    const undefinedNames: string[] = [];
    const nullNames: string[] = [];
    for (const name of names) {
      const value = (Index as Record<string, unknown>)[name];
      if (value === undefined) {
        undefinedNames.push(name);
        continue;
      }
      if (value === null) {
        nullNames.push(name);
      }
    }
    expect(
      undefinedNames,
      `src/index.ts re-exports names that are undefined at runtime: ${undefinedNames.join(", ")}. ` +
        "Most likely a `export { X } from \"./Y.js\"` line references a name `./Y.js` no longer exports.",
    ).toEqual([]);
    expect(
      nullNames,
      `src/index.ts re-exports names bound to null: ${nullNames.join(", ")}. ` +
        "A re-export probably resolved to a missing or removed module member.",
    ).toEqual([]);
  });
});

describe("public surface — README quickstart imports", () => {
  it.each(README_QUICKSTART_NAMES)(
    'README quotes `%s` from "./src/index.js" — must be defined',
    (name) => {
      expect(
        (Index as Record<string, unknown>)[name],
        `\`${name}\` is no longer exported from src/index.ts. ` +
          "The README's quickstart imports it directly (line 73 or 119-123) — " +
          "either restore the export or update the README.",
      ).toBeDefined();
    },
  );
});

describe("public surface — package.json#bin pre-build source", () => {
  it("`portfolio-context-mcp` maps to a real pre-build source file", () => {
    const pkg = loadPackageJson();
    const bin = pkg.bin ?? {};
    const target = bin["portfolio-context-mcp"];
    expect(
      target,
      "package.json#bin.portfolio-context-mcp is missing — the README's MCP wiring example would silently break",
    ).toBeDefined();
    expect(typeof target, "package.json#bin entries must be strings").toBe("string");

    // Map the dist/...js path back to its pre-build source via
    // tsconfig's rootDir = "." + outDir = "dist".
    const distPath = target as string;
    expect(
      distPath.startsWith("dist/"),
      `package.json#bin.portfolio-context-mcp = ${JSON.stringify(distPath)} ` +
        'should start with "dist/" (matches tsconfig outDir). If this changed, ' +
        "the bin → source mapping below also needs updating.",
    ).toBe(true);

    const sourceRelative = distPath
      .replace(/^dist\//, "")
      .replace(/\.js$/, ".ts");
    const sourceAbsolute = resolve(ROOT, sourceRelative);
    expect(
      existsSync(sourceAbsolute),
      `package.json#bin.portfolio-context-mcp points to ${JSON.stringify(distPath)}, ` +
        `which maps to source ${JSON.stringify(sourceRelative)} — but that file does not exist. ` +
        "Did the bin source move or get renamed? Update package.json#bin to match.",
    ).toBe(true);
  });
});
