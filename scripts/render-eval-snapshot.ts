#!/usr/bin/env tsx
import path from "node:path";
import process from "node:process";

import { renderEvalMarkdown } from "../src/eval/comment.js";
import { discoverCases, evaluateAll } from "../src/eval/runner.js";
import { atomicWriteFile } from "../src/io/atomic-write.js";

const FIXTURES_DIR = "fixtures/sample-prs";
const OUT_PATH = "docs/eval_snapshot.md";

async function main(): Promise<number> {
  const fixturesDir = path.resolve(FIXTURES_DIR);
  const outPath = path.resolve(OUT_PATH);
  const cases = await discoverCases(fixturesDir);
  if (cases.length === 0) {
    process.stderr.write(
      `no eval cases discovered under ${fixturesDir} — does each fixture have a sibling .golden.json?\n`,
    );
    return 1;
  }
  const run = await evaluateAll(cases);
  const md = renderEvalMarkdown(run);
  await atomicWriteFile(outPath, md);
  process.stdout.write(`wrote ${OUT_PATH} (${md.length} bytes)\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exit(2);
  },
);
