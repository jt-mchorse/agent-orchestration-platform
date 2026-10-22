/**
 * atomicWriteFile writes THROUGH a symlinked destination, as `fs.writeFile`
 * does (#197). It renamed its temp file onto the link, replacing it with a
 * regular file and leaving the linked file's old contents in place.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWriteFile } from "../../src/io/atomic-write.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aop-symlink-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("atomicWriteFile through a symlink (#197)", () => {
  it("keeps the link and writes the file it points at", async () => {
    const shared = path.join(root, "shared.md");
    const link = path.join(root, "eval_snapshot.md");
    await fs.writeFile(shared, "OLD\n");
    await fs.symlink(shared, link);
    await atomicWriteFile(link, "NEW\n");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(shared, "utf8")).toBe("NEW\n");
  });

  it("follows a relative two-hop chain", async () => {
    await fs.mkdir(path.join(root, "d"));
    await fs.writeFile(path.join(root, "d", "real.md"), "OLD\n");
    await fs.symlink("real.md", path.join(root, "d", "hop.md"));
    await fs.symlink(path.join("d", "hop.md"), path.join(root, "link.md"));
    await atomicWriteFile(path.join(root, "link.md"), "NEW\n");
    expect((await fs.lstat(path.join(root, "link.md"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(root, "d", "hop.md"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(root, "d", "real.md"), "utf8")).toBe("NEW\n");
  });

  it("a dangling link creates the file it names", async () => {
    const target = path.join(root, "made.md");
    await fs.symlink(target, path.join(root, "link.md"));
    await atomicWriteFile(path.join(root, "link.md"), "NEW\n");
    expect(await fs.readFile(target, "utf8")).toBe("NEW\n");
    expect((await fs.lstat(path.join(root, "link.md"))).isSymbolicLink()).toBe(true);
  });

  it("a loop rejects with ELOOP", async () => {
    await fs.symlink(path.join(root, "b"), path.join(root, "a"));
    await fs.symlink(path.join(root, "a"), path.join(root, "b"));
    await expect(atomicWriteFile(path.join(root, "a"), "x")).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("a plain path is written as before", async () => {
    await atomicWriteFile(path.join(root, "plain.md"), "NEW\n");
    expect((await fs.lstat(path.join(root, "plain.md"))).isFile()).toBe(true);
    expect(await fs.readdir(root)).toEqual(["plain.md"]);
  });
});

// A relative link target resolves against the directory the link physically
// lives in, not the path it was reached by (#258). Each case runs once with
// `fs.writeFile` and once with `atomicWriteFile` in fresh trees, and the
// resulting files must match.
describe("atomicWriteFile through a symlinked directory (#258)", () => {
  type Writer = (p: string, data: string) => Promise<void>;
  const plain: Writer = (p, data) => fs.writeFile(p, data);
  const atomic: Writer = (p, data) => atomicWriteFile(p, data);

  // Every regular file under `dir`, keyed by its path relative to `top`. Does
  // not descend into a symlinked directory (a recursive `readdir` does), so
  // each file is listed once, at its real path.
  async function regularFiles(top: string, dir = top): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) Object.assign(files, await regularFiles(top, p));
      else if (ent.isFile()) files[path.relative(top, p)] = await fs.readFile(p, "utf8");
    }
    return files;
  }

  // r/alias -> real/sub; `setup` adds links under real/sub. Returns every
  // regular file's contents under r after the write.
  async function run(
    write: Writer,
    setup: (r: string) => Promise<void>,
    requested: string,
  ): Promise<Record<string, string>> {
    const r = await fs.mkdtemp(path.join(root, "t-"));
    await fs.mkdir(path.join(r, "real", "sub"), { recursive: true });
    await fs.symlink(path.join("real", "sub"), path.join(r, "alias"));
    await setup(r);
    await write(path.join(r, requested), "NEW\n");
    return regularFiles(r);
  }

  async function same(setup: (r: string) => Promise<void>, requested: string) {
    const want = await run(plain, setup, requested);
    const got = await run(atomic, setup, requested);
    expect(got).toEqual(want);
    return got;
  }

  it("a '..' target climbs out of the real directory, not the alias", async () => {
    const got = await same(async (r) => {
      await fs.writeFile(path.join(r, "real", "target.md"), "OLD\n");
      await fs.symlink(path.join("..", "target.md"), path.join(r, "real", "sub", "out.md"));
    }, path.join("alias", "out.md"));
    expect(got).toEqual({ [path.join("real", "target.md")]: "NEW\n" });
  });

  it("a second hop reached through the alias resolves from its real directory", async () => {
    const got = await same(async (r) => {
      await fs.writeFile(path.join(r, "real", "target.md"), "OLD\n");
      await fs.symlink(path.join("..", "target.md"), path.join(r, "real", "sub", "hop.md"));
      await fs.symlink(path.join("alias", "hop.md"), path.join(r, "link.md"));
    }, "link.md");
    expect(got).toEqual({ [path.join("real", "target.md")]: "NEW\n" });
  });

  it("a dangling '..' target creates the file beside the real directory", async () => {
    const got = await same(async (r) => {
      await fs.symlink(path.join("..", "made.md"), path.join(r, "real", "sub", "out.md"));
    }, path.join("alias", "out.md"));
    expect(got).toEqual({ [path.join("real", "made.md")]: "NEW\n" });
  });

  it("control: a target with no '..' lands in the same file either way", async () => {
    const got = await same(async (r) => {
      await fs.writeFile(path.join(r, "real", "sub", "target.md"), "OLD\n");
      await fs.symlink("target.md", path.join(r, "real", "sub", "out.md"));
    }, path.join("alias", "out.md"));
    expect(got).toEqual({ [path.join("real", "sub", "target.md")]: "NEW\n" });
  });

  it("control: an absolute target through the alias is unaffected", async () => {
    const got = await same(async (r) => {
      await fs.writeFile(path.join(r, "real", "target.md"), "OLD\n");
      await fs.symlink(path.join(r, "real", "target.md"), path.join(r, "real", "sub", "out.md"));
    }, path.join("alias", "out.md"));
    expect(got).toEqual({ [path.join("real", "target.md")]: "NEW\n" });
  });

  it("control: a '..' link reached by its real path was already right", async () => {
    const got = await same(async (r) => {
      await fs.writeFile(path.join(r, "real", "target.md"), "OLD\n");
      await fs.symlink(path.join("..", "target.md"), path.join(r, "real", "sub", "out.md"));
    }, path.join("real", "sub", "out.md"));
    expect(got).toEqual({ [path.join("real", "target.md")]: "NEW\n" });
  });
});
