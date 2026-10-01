/**
 * File-mode contract for `src/io/atomic-write.ts::atomicWriteFile` (#157,
 * portfolio-ops#81).
 *
 * The helper used to open its temp file with an explicit `0o600`, and
 * `fs.rename` carries the temp's mode onto the target. Every new file came out
 * owner-only regardless of umask, and an overwrite demoted an existing 0644
 * file to 0600. The `fs.writeFile` the helper replaced did neither.
 *
 * Pinned here: a new file gets `0o666 & ~umask` (the kernel applies the umask),
 * and an overwrite keeps the target's existing permission bits. Each test sets
 * the umask it needs and restores the previous one in `finally`, because the
 * umask is process-global. vitest runs `pool: "forks"`, so `process.umask(mask)`
 * is allowed here (it throws inside a worker thread).
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../../src/io/atomic-write.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = path.join(
    tmpdir(),
    `aop-atomic-mode-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function modeOf(p: string): Promise<number> {
  return (await stat(p)).mode & 0o7777;
}

async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(prev);
  }
}

describe("atomicWriteFile — new-file mode follows the umask", () => {
  it("umask 022 → a new file is 0644, the same as a plain fs.writeFile", async () => {
    await withUmask(0o022, async () => {
      const plain = path.join(tmpRoot, "plain.txt");
      const out = path.join(tmpRoot, "new.txt");
      await writeFile(plain, "x");
      await atomicWriteFile(out, "x");
      expect(await modeOf(out)).toBe(0o644);
      expect(await modeOf(out)).toBe(await modeOf(plain));
    });
  });

  it("umask 077 → a new file is 0600 (the umask still narrows it)", async () => {
    await withUmask(0o077, async () => {
      const out = path.join(tmpRoot, "private.txt");
      await atomicWriteFile(out, "x");
      expect(await modeOf(out)).toBe(0o600);
    });
  });
});

describe("atomicWriteFile — an overwrite keeps the target's existing mode", () => {
  for (const existing of [0o644, 0o600, 0o640]) {
    it(`overwrite of a 0${existing.toString(8)} file stays 0${existing.toString(8)}`, async () => {
      // umask 022 so a mode-preserving overwrite and a umask-derived one
      // differ for 0600 and 0640. A fix that only switched to 0o666 without
      // the chmod would turn both into 0644.
      await withUmask(0o022, async () => {
        const out = path.join(tmpRoot, "existing.txt");
        await writeFile(out, "old");
        await chmod(out, existing);
        await atomicWriteFile(out, "new");
        expect(await modeOf(out)).toBe(existing);
        expect((await readdir(tmpRoot)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      });
    });
  }
});

describe("eval-runner writes its result JSON with the umask-derived mode (real caller)", () => {
  it(
    "umask 022 → the eval-*.json under --results-dir is 0644",
    async () => {
      // The child inherits the parent's umask at spawn time.
      const resultsDir = path.join(tmpRoot, "results");
      const code = await withUmask(
        0o022,
        () =>
          new Promise<number>((resolve, reject) => {
            const child = spawn(
              "npx",
              ["tsx", path.join("src", "bin", "eval-runner.ts"), "--results-dir", resultsDir],
              { cwd: REPO_ROOT, stdio: "ignore" },
            );
            child.on("close", (c) => resolve(c ?? -1));
            child.on("error", reject);
          }),
      );
      const files = (await readdir(resultsDir)).filter((n) => /^eval-.*\.json$/.test(n));
      expect(files, `eval-runner exited ${code} without writing a result`).toHaveLength(1);
      expect(await modeOf(path.join(resultsDir, files[0] as string))).toBe(0o644);
    },
    30_000,
  );
});
