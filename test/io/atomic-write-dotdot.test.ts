/**
 * A `..` after a symlinked directory in the REQUESTED path (#265). This is the
 * sibling of #258, which handled a `..` inside a link's target.
 *
 * `path.join` collapses `alias/..` lexically, but the kernel resolves it
 * through the link. The temp file was opened beside the alias while the rename
 * targeted the link's real parent. Across volumes the rename fails EXDEV. On
 * one volume a write into a new directory fails ENOENT, and an existing
 * directory just puts the temp in the wrong place. CI has one volume, so these
 * tests assert where the temp physically lives and what the write produces, and
 * do not depend on EXDEV.
 *
 * Requested paths are built by string concatenation, not `path.join`, so the
 * `..` reaches `atomicWriteFile` un-normalised, as `eval --results-dir
 * /abs/link/../results` passes it.
 */
import * as fsMod from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { atomicWriteFile } from "../../src/io/atomic-write.js";

let root: string;
beforeEach(async () => {
  // root/real/sub is the link target; root/r/alias -> root/real/sub. So
  // `r/alias/..` is root/real to the kernel, but root/r to `path.join`.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aop-dotdot-"));
  await fs.mkdir(path.join(root, "real", "sub"), { recursive: true });
  await fs.mkdir(path.join(root, "r"));
  await fs.symlink(path.join(root, "real", "sub"), path.join(root, "r", "alias"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

/** Write `requested` and return the PHYSICAL directory its temp file was in. */
async function tempDirFor(requested: string): Promise<string> {
  const renameSpy = vi.spyOn(fsMod.promises, "rename");
  await atomicWriteFile(requested, "NEW\n");
  const tmp = String(renameSpy.mock.calls[0]?.[0]);
  expect(path.basename(tmp)).toMatch(/^\..*\.\d+\.[0-9a-f]{12}\.tmp$/);
  return fs.realpath(path.dirname(tmp));
}

/** Every entry name under `dir`, recursively, without following links. */
async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    out.push(ent.name);
    if (ent.isDirectory()) out.push(...(await names(path.join(dir, ent.name))));
  }
  return out;
}

describe("atomicWriteFile with '..' after a symlinked directory (#265)", () => {
  it("puts the temp in the link's real parent, where the rename lands", async () => {
    const dir = await tempDirFor(`${root}/r/alias/../out.md`);
    expect(dir).toBe(await fs.realpath(path.join(root, "real")));
    expect(await fs.readFile(path.join(root, "real", "out.md"), "utf8")).toBe("NEW\n");
    await expect(fs.lstat(path.join(root, "r", "out.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("overwrites an existing file in the real parent, temp beside it", async () => {
    await fs.writeFile(path.join(root, "real", "target.md"), "OLD\n");
    const dir = await tempDirFor(`${root}/r/alias/../target.md`);
    expect(dir).toBe(await fs.realpath(path.join(root, "real")));
    expect(await fs.readFile(path.join(root, "real", "target.md"), "utf8")).toBe("NEW\n");
  });

  it("creates a new directory under the real parent (was ENOENT on one volume)", async () => {
    await atomicWriteFile(`${root}/r/alias/../newdir/out.md`, "NEW\n");
    expect(await fs.readFile(path.join(root, "real", "newdir", "out.md"), "utf8")).toBe("NEW\n");
    await expect(fs.lstat(path.join(root, "r", "newdir"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("control: matches fs.writeFile and leaves no temp behind", async () => {
    await fs.writeFile(`${root}/r/alias/../plain.md`, "NEW\n");
    await atomicWriteFile(`${root}/r/alias/../atomic.md`, "NEW\n");
    expect(await fs.readFile(path.join(root, "real", "atomic.md"), "utf8")).toBe(
      await fs.readFile(path.join(root, "real", "plain.md"), "utf8"),
    );
    expect((await names(root)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("control: a path through the alias with no '..' writes the real file", async () => {
    const dir = await tempDirFor(`${root}/r/alias/out.md`);
    expect(dir).toBe(await fs.realpath(path.join(root, "real", "sub")));
    expect(await fs.readFile(path.join(root, "real", "sub", "out.md"), "utf8")).toBe("NEW\n");
  });

  it("control: a plain path keeps its temp in its own directory", async () => {
    const dir = await tempDirFor(path.join(root, "r", "plain.md"));
    expect(dir).toBe(await fs.realpath(path.join(root, "r")));
    expect(await fs.readFile(path.join(root, "r", "plain.md"), "utf8")).toBe("NEW\n");
  });
});
