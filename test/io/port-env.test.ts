/**
 * `PORT` resolution rejects invalid values, not falsy ones (#132, D-014).
 *
 * `src/bin/trace-server.ts` read `Number(process.env.PORT) || 8766`. That rule
 * is "reject the values that are falsy, pass through the values that are
 * truthy", which is not the same rule as "accept a valid port". The table in
 * `it.each` below is the measured before/after; the `beforeFix` column is what
 * the old expression produced, kept as data so the change is visible rather
 * than asserted in prose.
 *
 * The site had been *exempted* from `env-read-population.test.ts` on the
 * grounds that `Number("  ")` is `0`, i.e. falsy, so it had no blank-but-truthy
 * hazard. True, and it excused the whole site from the rule while a different
 * defect sat in the same expression. The exemption is gone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PORT_RANGE, resolveIntEnv, resolvePort } from "../../src/io/env.js";

const DEFAULT = 8766;

/** What the pre-#132 expression produced, for the same input. */
const beforeFix = (raw: string | undefined): number => Number(raw) || DEFAULT;

describe("resolvePort", () => {
  it.each([
    ["a normal port", "8080", 8080],
    ["the documented default is reachable", "8766", 8766],
    ["the low bound", "0", 0],
    ["the high bound", "65535", 65535],
    ["leading and trailing whitespace is trimmed", "  8080  ", 8080],
    ["an explicit plus sign", "+8080", 8080],
  ])("accepts %s", (_label, raw, expected) => {
    expect(resolvePort(DEFAULT, { PORT: raw })).toBe(expected);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("falls back to the default when %s", (_label, raw) => {
    // #124's contract for this repo, and criterion 3 of #132: a set-but-empty
    // variable is treated as unset. This is the one place the grammar
    // deliberately differs from mcp-server-cookbook's, which throws on "".
    const env = raw === undefined ? {} : { PORT: raw };
    expect(resolvePort(DEFAULT, env)).toBe(DEFAULT);
  });

  it.each([
    ["a bare typo", "abc"],
    ["a digit-prefixed typo that looks like it should work", "8080abc"],
    ["a letter-O typo", "8O80"],
    ["hex", "0x10"],
    ["scientific notation", "1e3"],
    ["a trailing decimal", "8080.0"],
    ["a digit separator", "1_000"],
    ["a unit suffix", "5s"],
    ["below the range", "-1"],
    ["above the range", "70000"],
    ["far above the range", "99999999999999999999"],
  ])("rejects %s", (_label, raw) => {
    expect(() => resolvePort(DEFAULT, { PORT: raw })).toThrow(RangeError);
  });

  it("the error names the variable, the range, and the value it got", () => {
    // An operator who mistypes a port needs all three: which variable, what
    // shape it wanted, and what it actually read — the last one because
    // invisible characters and shell quoting are how this happens.
    expect(() => resolvePort(DEFAULT, { PORT: "8O80" })).toThrow(
      /env PORT must be an integer in \[0, 65535\].*got "8O80"/s,
    );
  });

  it("the error says how to get the default back", () => {
    expect(() => resolvePort(DEFAULT, { PORT: "abc" })).toThrow(/unset or empty.*8766/s);
  });
});

describe("what changed, measured against the old expression", () => {
  // The before/after table from #132. Every row where the two disagree is a
  // deliberate behaviour change; every row where they agree is a contract the
  // fix had to preserve.
  it.each([
    ["8080", 8080, "same"],
    ["", DEFAULT, "same"],
    ["   ", DEFAULT, "same"],
    ["0", 0, "changed"],
  ] as const)("PORT=%j resolves to %i (%s)", (raw, expected, verdict) => {
    expect(resolvePort(DEFAULT, { PORT: raw })).toBe(expected);
    if (verdict === "same") {
      expect(beforeFix(raw)).toBe(expected);
    } else {
      expect(beforeFix(raw)).not.toBe(expected);
    }
  });

  it.each(["abc", "8080abc", "-1", "70000"])(
    "PORT=%j used to resolve to something and now throws",
    (raw) => {
      // Anti-vacuous for the "rejects" block above: each of these really did
      // produce a number before, so the throw is a change rather than a
      // restatement of what already happened.
      expect(Number.isFinite(beforeFix(raw))).toBe(true);
      expect(() => resolvePort(DEFAULT, { PORT: raw })).toThrow(RangeError);
    },
  );

  it("0 was the one legitimate value the old rule could not express", () => {
    // `0 || default` is the entire bug for this row: port 0 asks the OS for an
    // ephemeral port, which is what container and test harnesses do.
    expect(beforeFix("0")).toBe(DEFAULT);
    expect(resolvePort(DEFAULT, { PORT: "0" })).toBe(0);
  });
});

describe("resolveIntEnv is general, not PORT-shaped", () => {
  it("honours the range it is given", () => {
    expect(resolveIntEnv("X", 5, { min: 1, max: 10 }, { X: "7" })).toBe(7);
    expect(() => resolveIntEnv("X", 5, { min: 1, max: 10 }, { X: "0" })).toThrow(RangeError);
    expect(() => resolveIntEnv("X", 5, { min: 1, max: 10 }, { X: "11" })).toThrow(RangeError);
  });

  it("bounds the magnitude before Number can lose precision", () => {
    // `Number("9007199254740993")` is 9007199254740992 — silently one lower.
    // The BigInt gate is what stops a value being accepted as a different
    // number than the operator wrote, and it has to run *before* the parse.
    expect(Number("9007199254740993")).toBe(9007199254740992);
    expect(() =>
      resolveIntEnv("X", 1, { min: 0, max: Number.MAX_SAFE_INTEGER }, { X: "9007199254740993" }),
    ).toThrow(RangeError);
  });

  it("PORT_RANGE is the range server.listen accepts", () => {
    expect(PORT_RANGE).toEqual({ min: 0, max: 65535 });
  });

  it("reads process.env when no env is passed", () => {
    // The default parameter is what the production call site uses, so it needs
    // its own arm — every other test here injects an env object.
    const saved = process.env.PORT;
    try {
      process.env.PORT = "12345";
      expect(resolvePort(DEFAULT)).toBe(12345);
      delete process.env.PORT;
      expect(resolvePort(DEFAULT)).toBe(DEFAULT);
    } finally {
      if (saved === undefined) delete process.env.PORT;
      else process.env.PORT = saved;
    }
  });
});


describe("the call site itself", () => {
  // The population rule in `env-read-population.test.ts` is a file-level
  // heuristic: a file that reads `process.env` must also *mention* an env
  // helper. Restoring `Number(process.env.PORT) || DEFAULT_PORT` in
  // `trace-server.ts` while the `resolvePort` import is still at the top
  // satisfies that rule and turns nothing red — measured, not assumed. So the
  // call site gets its own lock, stated positively and negatively, because
  // neither half alone catches a half-revert.
  const source = (): string =>
    readFileSync(join(import.meta.dirname, "..", "..", "src", "bin", "trace-server.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("trace-server resolves its port through the helper", () => {
    expect(source()).toMatch(/resolvePort\(DEFAULT_PORT\)/);
  });

  it("trace-server does not coerce PORT itself", () => {
    // Comments are stripped first, so the note above the call — which *quotes*
    // the old expression — is not itself the offender.
    expect(source()).not.toMatch(/Number\(\s*process\.env/);
  });

  it("the default the helper is handed is the one the README documents", () => {
    const readme = readFileSync(
      join(import.meta.dirname, "..", "..", "README.md"),
      "utf8",
    );
    expect(source()).toMatch(/const DEFAULT_PORT = 8766;/);
    expect(readme).toContain("localhost:8766");
  });
});
