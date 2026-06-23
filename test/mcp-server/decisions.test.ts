import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decisionsFilePath,
  parseCoreDecisionsMarkdown,
  readCoreDecisions,
} from "../../mcp-server/portfolio-context/decisions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.resolve(here, "../../.tmp-portfolio-decisions");

const SAMPLE = `# Core Decisions (AI-readable, YAML, append-only)
# Schema: see .skills/portfolio-memory/SKILL.md

- id: D-001
  date: 2026-05-10
  decision: scope_per_portfolio_handoff_section_2
  rationale: locked_scope_prevents_drift
  alternatives_rejected: []
  reversibility: expensive
  related_issues: []
  superseded_by: D-003

- id: D-002
  # superseded by D-003
  date: 2026-05-10
  decision: stub_trending_scripts_at_bootstrap_implement_in_session_one
  rationale: handoff_forbids_pretending_things_work
  alternatives_rejected: [implement_full_scanner_during_bootstrap, omit_workflows_entirely]
  reversibility: cheap
  related_issues: [#11, #14]
  superseded_by: D-003

- id: D-003
  date: 2026-05-11
  decision: real_trending_scripts_implemented_using_stdlib_only
  rationale: bootstrap_proceeds_to_functional_state
  alternatives_rejected: [keep_stubs_and_defer]
  reversibility: cheap
  related_issues: []
  superseded_by: null
`;

describe("parseCoreDecisionsMarkdown", () => {
  it("parses three sequential decisions with the expected fields", () => {
    const decisions = parseCoreDecisionsMarkdown(SAMPLE);
    expect(decisions).toHaveLength(3);
    expect(decisions[0]?.id).toBe("D-001");
    expect(decisions[0]?.reversibility).toBe("expensive");
    expect(decisions[0]?.superseded_by).toBe("D-003");
    expect(decisions[0]?.alternatives_rejected).toEqual([]);
  });

  it("parses inline arrays with multiple items and #-prefixed issue refs", () => {
    const decisions = parseCoreDecisionsMarkdown(SAMPLE);
    const d2 = decisions[1];
    expect(d2?.alternatives_rejected).toEqual([
      "implement_full_scanner_during_bootstrap",
      "omit_workflows_entirely",
    ]);
    expect(d2?.related_issues).toEqual(["#11", "#14"]);
  });

  it("treats `superseded_by: null` as null, not the string 'null'", () => {
    const decisions = parseCoreDecisionsMarkdown(SAMPLE);
    expect(decisions[2]?.superseded_by).toBeNull();
  });

  it("returns an empty array for a file with only comments and blank lines", () => {
    const decisions = parseCoreDecisionsMarkdown("# only comments\n# nothing else\n\n");
    expect(decisions).toEqual([]);
  });

  it("maps unknown reversibility tokens to 'unknown' rather than throwing", () => {
    const decisions = parseCoreDecisionsMarkdown(`- id: D-99\n  reversibility: maybe\n`);
    expect(decisions[0]?.reversibility).toBe("unknown");
  });
});

describe("decisionsFilePath", () => {
  it("routes portfolio-ops to its own MEMORY directory", () => {
    const p = decisionsFilePath("/abs/root", "portfolio-ops");
    expect(p).toBe("/abs/root/portfolio-ops/MEMORY/core_decisions_ai.md");
  });

  it("routes a normal repo under repos/<slug>/MEMORY", () => {
    const p = decisionsFilePath("/abs/root", "rag-production-kit");
    expect(p).toBe("/abs/root/repos/rag-production-kit/MEMORY/core_decisions_ai.md");
  });

  it("rejects repo names with path separators or shell metacharacters", () => {
    expect(() => decisionsFilePath("/abs/root", "../etc")).toThrow(/invalid repo name/);
    expect(() => decisionsFilePath("/abs/root", "a/b")).toThrow(/invalid repo name/);
  });

  it("rejects repo names containing a backslash separator", () => {
    // A stray `\\` in the sanitizer's character class used to whitelist the
    // backslash, so a Windows-style separator slipped past the trust boundary.
    expect(() => decisionsFilePath("/abs/root", "a\\b")).toThrow(/invalid repo name/);
    expect(() => decisionsFilePath("/abs/root", "..\\..\\secret")).toThrow(/invalid repo name/);
  });

  it("still accepts legitimate hyphen/dot/underscore slugs", () => {
    // Guard against over-tightening: valid slugs must keep resolving.
    expect(decisionsFilePath("/abs/root", "good-repo.1_v2")).toBe(
      "/abs/root/repos/good-repo.1_v2/MEMORY/core_decisions_ai.md",
    );
  });
});

describe("readCoreDecisions", () => {
  const repo = "rag-production-kit";
  const memoryDir = path.join(tmpRoot, "repos", repo, "MEMORY");
  const decisionsFile = path.join(memoryDir, "core_decisions_ai.md");

  beforeAll(async () => {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(decisionsFile, SAMPLE, "utf8");
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("reads and parses the file when present", async () => {
    const result = await readCoreDecisions(tmpRoot, repo);
    expect(result.repo).toBe(repo);
    expect(result.source).toBe(decisionsFile);
    expect(result.decisions.map((d) => d.id)).toEqual(["D-001", "D-002", "D-003"]);
  });

  it("throws ENOENT-shaped error when the file is missing", async () => {
    await expect(readCoreDecisions(tmpRoot, "no-such-repo")).rejects.toThrow();
  });
});
