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

export async function atomicWriteFile(
  target: string,
  data: string | Buffer,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, encoding) : data;
  const dir = path.dirname(target);
  const base = path.basename(target);
  await fs.mkdir(dir, { recursive: true });

  const token = randomBytes(6).toString("hex");
  const tmp = path.join(dir, `.${base}.${process.pid}.${token}.tmp`);

  // O_WRONLY | O_CREAT | O_EXCL — fail loudly if the temp name
  // already exists (collision with a concurrent attempt by another
  // process); never silently clobber.
  const handle = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  let renamed = false;
  try {
    await handle.writeFile(buf);
    await handle.sync();
    await handle.close();
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
