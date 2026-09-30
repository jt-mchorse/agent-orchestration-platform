/**
 * `.env.example` lists every environment variable `src/` reads (#151).
 *
 * Handoff §10 says each repo gets a `.env.example`; this one had none, and the
 * code reads four variables the README names only two of. The set is derived
 * from the source in every spelling it is read by -- `process.env.X`,
 * `process.env["X"]`, `firstNonBlankEnv([...])`, `resolveIntEnv("X", ...)` and
 * the `TOKEN_ENV_NAMES` list -- so a new read fails here until it is listed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

export function envNamesRead(text: string): Set<string> {
  const names = new Set<string>();
  const add = (m: RegExpMatchArray | null, group = 1) => {
    const value = m?.[group];
    if (value) names.add(value);
  };
  for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) add(m);
  for (const m of text.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g)) add(m);
  for (const m of text.matchAll(/resolveIntEnv\(\s*["']([A-Z][A-Z0-9_]+)["']/g)) add(m);
  for (const m of text.matchAll(/(?:firstNonBlankEnv\(|TOKEN_ENV_NAMES\s*=)\s*\[([^\]]*)\]/g)) {
    for (const lit of (m[1] ?? "").matchAll(/["']([A-Z][A-Z0-9_]+)["']/g)) add(lit);
  }
  return names;
}

const READ = new Set(
  sourceFiles(join(ROOT, "src")).flatMap((p) => [
    ...envNamesRead(readFileSync(p, "utf-8").replace(/^\s*(\/\/|\*).*$/gm, "")),
  ]),
);
const EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf-8");
const LISTED = new Set([...EXAMPLE.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1] ?? ""));

describe(".env.example covers every variable the source reads (#151)", () => {
  it("lists each one", () => {
    expect([...READ].filter((n) => !LISTED.has(n)).sort()).toEqual([]);
  });

  it("the derivation finds the four known reads (non-vacuity)", () => {
    for (const name of ["DATABASE_URL", "GITHUB_TOKEN", "GH_TOKEN", "PORT", "PORTFOLIO_ROOT"]) {
      expect(READ.has(name), name).toBe(true);
    }
  });

  it("recognises every spelling it claims to", () => {
    const sample = [
      "process.env.A_ONE",
      'process.env["B_TWO"]',
      'resolveIntEnv("C_THREE", 1, r)',
      'firstNonBlankEnv(["D_FOUR", "E_FIVE"], env)',
      'export const TOKEN_ENV_NAMES = ["F_SIX"] as const;',
    ].join("\n");
    expect([...envNamesRead(sample)].sort()).toEqual(
      ["A_ONE", "B_TWO", "C_THREE", "D_FOUR", "E_FIVE", "F_SIX"].sort(),
    );
  });

  it("holds no real-looking secret", () => {
    expect(EXAMPLE).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-ant-/);
  });
});
