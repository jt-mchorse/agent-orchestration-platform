/**
 * Atomic file write helper.
 *
 * `fs.promises.writeFile` is not atomic: the destination is opened
 * with `O_WRONLY | O_CREAT | O_TRUNC` (truncates immediately), and
 * the bytes only commit on `close()`. If the process is killed
 * mid-write — SIGINT/SIGTERM, OOM, disk-full, EMFILE — the destination
 * is left zero-length or partial.
 *
 * For this repo the harm shape is:
 * - `src/bin/eval-runner.ts` writes the eval-result JSON (~150–500
 *   bytes per case × N cases). Downstream CI workflows can upload it
 *   as an artifact or feed it to a sticky-PR-comment renderer; a
 *   partial JSON poisons every consumer with `SyntaxError: JSON.parse`.
 * - `scripts/render-eval-snapshot.ts` writes `docs/eval_snapshot.md`,
 *   the markdown the README's "Evaluation snapshot" section renders
 *   from on GitHub. A partial render is a front-page failure.
 *
 * Pattern is the TypeScript sibling of the Python helpers landed
 * across the portfolio:
 *   - `rag_kit/io_utils.atomic_write_text` (rag-production-kit#44/#45)
 *   - `eval_harness/io_utils.atomic_write_text` (llm-eval-harness#51, D-015)
 *   - `emb_shootout/io_utils.atomic_write_text` (embedding-model-shootout#37, D-009)
 * And the TypeScript pattern leader:
 *   - `servers/filesystem-sandbox/src/atomic_write.ts` (mcp-server-cookbook#37)
 *
 * Load-bearing constraint: the temp file lives in the destination's
 * parent directory so the rename is same-filesystem (`fs.rename` is
 * atomic on POSIX within the same filesystem; cross-filesystem renames
 * degrade to a copy-then-unlink, which is not atomic).
 */

import { randomBytes } from "node:crypto";
import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";

// Cap the target basename's contribution to the temp filename (#137). The temp
// name is `.<base>.<pid>.<12-hex>.tmp`, so the affixes are two separator dots,
// the pid, another dot, 12 hex characters and `.tmp` — base + 25 bytes in the
// worst case, since a Linux pid can be 7 digits. Prepending a full basename
// that is itself near NAME_MAX (255 on ext4/APFS) overflows the limit and the
// write fails ENAMETOOLONG, even though a plain `fs.writeFile` of that same
// target succeeds. Measured: the threshold is ~231 bytes of basename; at 236 B
// the plain write is fine and the temp name is 260 B and fails.
//
// 200 leaves ~30 bytes of headroom over that arithmetic. Same constant and same
// shape as the pattern leader this file's docstring already names
// (`mcp-server-cookbook/servers/filesystem-sandbox/src/atomic_write.ts`, #96)
// and the Python siblings (`rag-production-kit#128`, and the
// `_MAX_TEMP_BASE_BYTES` in every `io_utils.atomic_write_text`). This port was
// copied from the pre-#96 shape and never received the follow-up, so the family
// claim in the docstring above was prose the code did not honour.
//
// The base in the temp name is cosmetic (`ls`-ability); uniqueness comes from
// the pid + 12 random hex + O_EXCL, so truncating it is safe. Budget is in
// BYTES because NAME_MAX is a byte limit, and we trim by whole characters so a
// multi-byte codepoint is never split.
const MAX_TEMP_BASE_BYTES = 200;

function capBaseForTemp(base: string): string {
  if (Buffer.byteLength(base, "utf8") <= MAX_TEMP_BASE_BYTES) return base;
  let out = base;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > MAX_TEMP_BASE_BYTES) {
    out = out.slice(0, -1);
  }
  return out;
}

// The file a write to `target` lands in: through a symlinked final component,
// as `fs.writeFile` does (#197). `fs.rename` replaces a LINK with a regular
// file and leaves the file it pointed at stale. A dangling link resolves to the
// path it names, which the write then creates; a loop fails with ELOOP after
// the kernel's own limit instead of spinning. Same helper as
// ai-app-integration-tests#181; the TypeScript twin of the Python
// `atomic_write_text` fix (leh#327 and siblings).
const MAX_SYMLINK_HOPS = 40;

async function resolveSymlinkedTarget(target: string): Promise<string> {
  let current = target;
  for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(current)).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw err;
    }
    if (!isLink) return current;
    current = path.resolve(path.dirname(current), await fs.readlink(current));
  }
  const err = new Error(`ELOOP: too many symbolic links, write '${target}'`) as NodeJS.ErrnoException;
  err.code = "ELOOP";
  throw err;
}

export async function atomicWriteFile(
  requested: string,
  data: string | Buffer,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, encoding) : data;
  const target = await resolveSymlinkedTarget(requested);
  const dir = path.dirname(target);
  const base = path.basename(target);
  await fs.mkdir(dir, { recursive: true });

  const token = randomBytes(6).toString("hex");
  const tmp = path.join(dir, `.${capBaseForTemp(base)}.${process.pid}.${token}.tmp`);

  // O_WRONLY | O_CREAT | O_EXCL — fail loudly if the temp name
  // already exists (collision with a concurrent attempt by another
  // process); never silently clobber.
  //
  // Mode 0o666, not 0o600 (#157, portfolio-ops#81): `fs.rename` carries the
  // temp file's mode onto the target, so an explicit 0o600 made every new
  // file owner-only regardless of umask and demoted an existing 0644 file to
  // 0600. 0o666 lets the KERNEL apply the umask, exactly as the
  // `fs.writeFile` this helper replaced did; the process umask is never
  // touched (it is process-global).
  const handle = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o666);
  let renamed = false;
  try {
    await handle.writeFile(buf);
    await handle.sync();
    await handle.close();
    // An overwrite keeps the target's existing permission bits, as an
    // in-place `fs.writeFile` would. A missing target is a new file.
    let existingMode: number | undefined;
    try {
      existingMode = (await fs.stat(target)).mode & 0o7777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existingMode !== undefined) await fs.chmod(tmp, existingMode);
    await fs.rename(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await handle.close();
      } catch {
        // Already closed (the try block reached `handle.close()` before
        // a later step threw) — nothing to do.
      }
      try {
        await fs.unlink(tmp);
      } catch {
        // Temp may already be gone (race with another cleanup, or it
        // was never created because open itself threw). Either way
        // there is no leftover for us to remove.
      }
    }
  }
}
