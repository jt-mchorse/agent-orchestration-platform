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
