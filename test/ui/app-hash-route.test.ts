import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A malformed `#run=` escape blanked the trace viewer (#223).
 *
 * `useHashRoute` ran `decodeURIComponent` on the hash during render, and
 * `#run=%` threw `URIError` with no error boundary to catch it. The server
 * fixed the same throw for `/api/runs/%` in #155, which decided that a
 * malformed id names no run. The client now keeps the raw capture, which
 * `RunDetail` encodes, the server decodes back, and answers 404.
 *
 * `app.js` imports React from a CDN and renders at import time, so it cannot be
 * imported here. The test evaluates the shipped `runIdFromHash` source
 * verbatim, so it runs the code the browser runs rather than a copy of it.
 */
const APP_JS = readFileSync(path.resolve(__dirname, "../../src/ui/app.js"), "utf8");

function loadRunIdFromHash(): (hash: string) => string | null {
  const source = APP_JS.match(/^function runIdFromHash\(hash\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  if (!source) throw new Error("runIdFromHash not found in src/ui/app.js");
  return new Function(`${source}\nreturn runIdFromHash;`)() as (hash: string) => string | null;
}

const runIdFromHash = loadRunIdFromHash();

describe("trace viewer app.js: runIdFromHash (#223)", () => {
  it.each([
    ["#run=%", "%"],
    ["#run=%ZZ", "%ZZ"],
    ["#run=%E0%A4%A", "%E0%A4%A"],
    ["#run=abc%", "abc%"],
  ])("a malformed escape %j does not throw; the raw capture is the id", (hash, id) => {
    expect(() => runIdFromHash(hash)).not.toThrow();
    expect(runIdFromHash(hash)).toBe(id);
  });

  it("the raw id round-trips through RunDetail's encode and the server's decode", () => {
    const id = runIdFromHash("#run=%") as string;
    // RunDetail fetches "/api/runs/" + encodeURIComponent(runId); the server's
    // route decodes the segment, so it looks up "%" and answers 404.
    expect(decodeURIComponent(encodeURIComponent(id))).toBe("%");
  });

  it("well-formed ids decode as before", () => {
    expect(runIdFromHash("#run=sample-finalized")).toBe("sample-finalized");
    expect(runIdFromHash("#run=%25")).toBe("%");
    expect(runIdFromHash("#run=a%2Fb&x=1")).toBe("a/b");
    expect(runIdFromHash("#run=" + encodeURIComponent("run é\u{1F600}"))).toBe(
      "run é\u{1F600}",
    );
  });

  it("a hash that names no run is null", () => {
    expect(runIdFromHash("")).toBeNull();
    expect(runIdFromHash("#")).toBeNull();
    expect(runIdFromHash("#run=")).toBeNull();
    expect(runIdFromHash("#other=1")).toBeNull();
  });
});
