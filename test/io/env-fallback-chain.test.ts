/**
 * A set-but-empty environment variable does not defeat its own fallback (#124).
 *
 * This repo had four env-reading sites and three conventions:
 *
 *     src/bin/trace-server.ts   Number(process.env.PORT) || 8766        correct
 *     test/trace/pg-store.test  DATABASE_URL ? it : it.skip             correct
 *     src/eval/comment.ts       process.env.GITHUB_TOKEN ?? GH_TOKEN    BUG
 *     src/trace/pg-store.ts     opts.x ?? process.env.DATABASE_URL ?? d BUG
 *
 * `??` fires on `null`/`undefined` only. Measured on `resolveToken` before the
 * fix:
 *
 *     case                                 result
 *     both unset                           THROWS "GitHub token missing ..."
 *     GITHUB_TOKEN set                     -> "ghp_A"
 *     GH_TOKEN set only                    -> "ghp_B"
 *     GITHUB_TOKEN='' + GH_TOKEN set       THROWS   <- GH_TOKEN set and ignored
 *     GITHUB_TOKEN='  ' + GH_TOKEN set     -> "  "  <- sent as `Bearer   `
 *     opts.token='' + GH_TOKEN set         -> "ghp_B"  (already correct)
 *
 * The first of the two bugs throws an error naming, in its own text, the
 * variable that *is* correctly set. The second is worse: `"  "` is truthy, so
 * it slipped past the `!env` guard and went out as an Authorization header,
 * turning a clear "token missing" into a 401 from GitHub.
 *
 * Reachability is ordinary. `GITHUB_TOKEN` is not automatically present in a
 * GitHub Actions job — it has to be mapped, and
 * `env: GITHUB_TOKEN: ${{ secrets.SOMETHING }}` with an unset or misspelled
 * secret expands to an **empty string, not to unset**.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { firstNonBlank, firstNonBlankEnv } from "../../src/io/env.js";
import { DEFAULT_CONNECTION_STRING } from "../../src/trace/pg-store.js";

const VARS = ["GITHUB_TOKEN", "GH_TOKEN", "DATABASE_URL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

// ----------------------------------------------------------------------
// The rule
// ----------------------------------------------------------------------

describe("firstNonBlank", () => {
  it("skips an empty candidate and reaches the next one", () => {
    expect(firstNonBlank(["", "second"], "fallback")).toBe("second");
  });

  it.each([[""], ["   "], ["\t"], ["\n"], [undefined]])(
    "treats %j as blank rather than as a value",
    (blank) => {
      expect(firstNonBlank([blank, "second"], "fallback")).toBe("second");
    },
  );

  it("returns the fallback when every candidate is blank", () => {
    expect(firstNonBlank([undefined, "", "  "], "fallback")).toBe("fallback");
  });

  it("preserves precedence — the first non-blank wins", () => {
    expect(firstNonBlank(["first", "second"], "fallback")).toBe("first");
  });

  it("trims the value it returns", () => {
    // An untrimmed credential is the case that slipped through truthy and went
    // out as `Authorization: Bearer   `.
    expect(firstNonBlank(["  ghp_A  "], "fallback")).toBe("ghp_A");
  });
});

describe("firstNonBlankEnv", () => {
  it("reaches GH_TOKEN when GITHUB_TOKEN is empty", () => {
    process.env.GITHUB_TOKEN = "";
    process.env.GH_TOKEN = "ghp_B";
    expect(firstNonBlankEnv(["GITHUB_TOKEN", "GH_TOKEN"])).toBe("ghp_B");
  });

  it("reaches GH_TOKEN when GITHUB_TOKEN is whitespace-only", () => {
    process.env.GITHUB_TOKEN = "  ";
    process.env.GH_TOKEN = "ghp_B";
    expect(firstNonBlankEnv(["GITHUB_TOKEN", "GH_TOKEN"])).toBe("ghp_B");
  });

  it("still prefers GITHUB_TOKEN when it is set — the order is unchanged", () => {
    process.env.GITHUB_TOKEN = "ghp_A";
    process.env.GH_TOKEN = "ghp_B";
    expect(firstNonBlankEnv(["GITHUB_TOKEN", "GH_TOKEN"])).toBe("ghp_A");
  });

  it("returns undefined when every name is blank", () => {
    process.env.GITHUB_TOKEN = "";
    process.env.GH_TOKEN = "   ";
    expect(firstNonBlankEnv(["GITHUB_TOKEN", "GH_TOKEN"])).toBeUndefined();
  });
});

// ----------------------------------------------------------------------
// The two sites, through their public entry points
// ----------------------------------------------------------------------

describe("resolveToken, through upsertStickyComment's option surface", () => {
  async function resolve(opts: Record<string, unknown>): Promise<string | Error> {
    const { findStickyCommentId } = await import("../../src/eval/comment.js");
    let seen: string | undefined;
    try {
      await findStickyCommentId("o/r", 1, {
        ...opts,
        // Capture the Authorization header rather than mocking `resolveToken`:
        // the property under test is what actually reaches the wire.
        fetchImpl: (async (_url: unknown, init: { headers: Record<string, string> }) => {
          seen = init.headers.Authorization;
          return { ok: true, status: 200, json: async () => [], text: async () => "" };
        }) as unknown as typeof fetch,
      });
    } catch (e) {
      return e as Error;
    }
    return seen ?? "";
  }

  it("uses GH_TOKEN when GITHUB_TOKEN is empty", async () => {
    process.env.GITHUB_TOKEN = "";
    process.env.GH_TOKEN = "ghp_B";
    expect(await resolve({})).toBe("Bearer ghp_B");
  });

  it("never sends a whitespace-only token as a Bearer credential", async () => {
    process.env.GITHUB_TOKEN = "  ";
    process.env.GH_TOKEN = "ghp_B";
    expect(await resolve({})).toBe("Bearer ghp_B");
  });

  it("throws — not `Bearer   ` — when every source is blank", async () => {
    process.env.GITHUB_TOKEN = "  ";
    const result = await resolve({});
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/GitHub token missing/);
  });

  it("says that a blank value counts as missing", async () => {
    // Otherwise the message names GITHUB_TOKEN as a remedy while the operator
    // is looking at a GITHUB_TOKEN they have already set.
    process.env.GITHUB_TOKEN = "";
    const result = await resolve({});
    expect((result as Error).message).toMatch(/empty or whitespace-only value counts as missing/);
  });

  it("keeps opts.token's precedence", async () => {
    process.env.GITHUB_TOKEN = "ghp_A";
    expect(await resolve({ token: "ghp_C" })).toBe("Bearer ghp_C");
  });

  it("keeps an empty opts.token falling through — this was already correct", async () => {
    process.env.GH_TOKEN = "ghp_B";
    expect(await resolve({ token: "" })).toBe("Bearer ghp_B");
  });

  it("trims a padded token rather than sending the padding", async () => {
    process.env.GITHUB_TOKEN = "  ghp_A  ";
    expect(await resolve({})).toBe("Bearer ghp_A");
  });
});

describe("PgStore's connection string", () => {
  // `getPool` is private and dynamically imports `pg`, so the resolution rule
  // is asserted directly against the same helper and the exported default —
  // which is what the site now uses. A test that spun up Postgres would be
  // testing `pg`, not this.
  it("an empty DATABASE_URL reaches the documented default", () => {
    expect(firstNonBlank([undefined, ""], DEFAULT_CONNECTION_STRING)).toBe(
      DEFAULT_CONNECTION_STRING,
    );
  });

  it("an empty opts.connectionString falls through to DATABASE_URL", () => {
    expect(firstNonBlank(["", "postgresql://from-env/db"], DEFAULT_CONNECTION_STRING)).toBe(
      "postgresql://from-env/db",
    );
  });

  it("opts.connectionString still wins when set", () => {
    expect(firstNonBlank(["postgresql://explicit/db", "postgresql://env/db"], DEFAULT_CONNECTION_STRING)).toBe(
      "postgresql://explicit/db",
    );
  });

  it("the documented default matches what docs/architecture.md and init.sql use", () => {
    expect(DEFAULT_CONNECTION_STRING).toBe("postgresql://agent:agent@localhost:5433/agent_trace");
  });
});
