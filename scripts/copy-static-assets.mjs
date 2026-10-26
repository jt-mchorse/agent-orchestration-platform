#!/usr/bin/env node
// Copy the non-TypeScript files under src/ into <outDir>/src/ (#269).
//
// `tsc` emits only what it compiles, so the trace viewer's `src/ui/index.html`
// and `src/ui/app.js` never reached `dist/src/ui/`, and the built trace server
// answered 404 for `/` and `/app.js` from its default static dir (the sibling
// of `dist/src/ui/server.js`). Every non-`.ts` file under src/ is copied rather
// than a list of two, so a new asset beside the server cannot be left behind.
//
// Usage: node scripts/copy-static-assets.mjs [outDir]   (default: dist)
// Plain node with no dependencies so `npm run build` stays cross-platform.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");
const outRoot = path.resolve(repoRoot, process.argv[2] ?? "dist", "src");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && !entry.name.endsWith(".ts") ? [full] : [];
  });
}

for (const file of walk(srcRoot)) {
  const dest = path.join(outRoot, path.relative(srcRoot, file));
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(file, dest);
}
