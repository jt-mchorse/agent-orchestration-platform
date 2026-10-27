/**
 * Run the `build` script's own steps into a scratch outDir (#269, #275).
 *
 * The steps are parsed from `package.json#scripts.build`, so a test that builds
 * through this follows whatever `npm run build` does. The outDir should be a
 * gitignored `.tmp-*` dir inside the checkout: the built bins then resolve
 * `node_modules` the way `dist/` does, which a tmpdir outside the repo cannot.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");

export function buildScript(): string {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts.build as string;
}

export function buildInto(outDir: string): void {
  for (const step of buildScript().split("&&").map((s) => s.trim().split(/\s+/))) {
    const [cmd, ...args] = step;
    if (cmd === "tsc") {
      const tsc = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tsc, ...args, "--outDir", outDir], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
    } else if (cmd === "node") {
      execFileSync(process.execPath, [...args, outDir], { cwd: REPO_ROOT, stdio: "pipe" });
    } else {
      throw new Error(`unrecognised build step: ${step.join(" ")}`);
    }
  }
}
