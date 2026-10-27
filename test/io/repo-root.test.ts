/**
 * `findRepoRoot` walks up to the nearest `package.json` (#275).
 *
 * The built-layout end-to-end arm is `test/eval/eval-runner-built.test.ts`.
 * These arms pin the helper on its own: the root is the same from a
 * `src/bin/`-shaped dir and a `dist/src/bin/`-shaped dir, the NEAREST
 * `package.json` wins, and this checkout resolves from both bin locations.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findRepoRoot, repoRootOf } from "../../src/io/repo-root.js";
import { REPO_ROOT } from "../helpers/build-into.js";

describe("findRepoRoot (#275)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "aop-repo-root-"));
    writeFileSync(path.join(root, "package.json"), "{}");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("gives the same root from src/bin/ and dist/src/bin/", () => {
    const src = path.join(root, "src", "bin");
    const dist = path.join(root, "dist", "src", "bin");
    mkdirSync(src, { recursive: true });
    mkdirSync(dist, { recursive: true });
    // The old `here/../..` gave `root` for src/bin/ and `root/dist` for the build.
    expect(path.resolve(dist, "..", "..")).toBe(path.join(root, "dist"));
    expect(findRepoRoot(src)).toBe(root);
    expect(findRepoRoot(dist)).toBe(root);
  });

  it("stops at the nearest package.json, not the outermost", () => {
    const inner = path.join(root, "packages", "inner");
    mkdirSync(path.join(inner, "src", "bin"), { recursive: true });
    writeFileSync(path.join(inner, "package.json"), "{}");
    expect(findRepoRoot(path.join(inner, "src", "bin"))).toBe(inner);
  });

  it("resolves this checkout from the source and the built bin location", () => {
    const srcBin = path.join(REPO_ROOT, "src", "bin", "eval-runner.ts");
    const distBin = path.join(REPO_ROOT, "dist", "src", "bin", "eval-runner.js");
    expect(repoRootOf(pathToFileURL(srcBin).href)).toBe(REPO_ROOT);
    expect(repoRootOf(pathToFileURL(distBin).href)).toBe(REPO_ROOT);
  });
});
