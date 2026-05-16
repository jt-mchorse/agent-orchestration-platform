import { describe, expect, it } from "vitest";
import { STICKY_MARKER, renderEvalMarkdown, upsertStickyComment, findStickyCommentId } from "../../src/eval/comment.js";
import type { EvalRun } from "../../src/eval/runner.js";

function fakeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    cases: [
      {
        fixture_id: "alpha",
        actual: {
          summary: "actual summary",
          findings: [],
          recommendation: "approve",
        },
        golden: {
          summary: "golden summary",
          findings: [],
          recommendation: "approve",
        },
        score: {
          recommendation_match: 1,
          recommendation_actual: "approve",
          recommendation_golden: "approve",
          findings_precision: 0,
          findings_recall: 0,
          findings_f1: 0,
          matched_findings: 0,
          total_actual_findings: 0,
          total_golden_findings: 0,
          summary_length_ratio: 0.9,
          summary_actual_chars: 14,
          summary_golden_chars: 14,
          composite: 0.59,
        },
      },
    ],
    composite_mean: 0.59,
    recommendation_accuracy: 1.0,
    findings_f1_mean: 0,
    ...overrides,
  };
}

describe("renderEvalMarkdown", () => {
  it("includes the sticky marker at the top of the body", () => {
    const md = renderEvalMarkdown(fakeRun());
    expect(md.startsWith(STICKY_MARKER)).toBe(true);
  });

  it("renders one table row per fixture", () => {
    const md = renderEvalMarkdown(fakeRun());
    expect(md).toContain("| `alpha` |");
  });

  it("indicates failure with :x: emoji when recommendation differs", () => {
    const run = fakeRun({
      cases: [
        {
          ...fakeRun().cases[0]!,
          score: {
            ...fakeRun().cases[0]!.score,
            recommendation_match: 0,
            recommendation_actual: "approve",
            recommendation_golden: "request_changes",
          },
        },
      ],
    });
    const md = renderEvalMarkdown(run);
    expect(md).toContain(":x:");
    expect(md).toContain("approve vs request_changes");
  });

  it("headline shows OK when composite is high", () => {
    const md = renderEvalMarkdown(
      fakeRun({ composite_mean: 0.9 }),
    );
    expect(md).toContain(":white_check_mark: composite ≥ 0.85");
  });

  it("headline shows :warning: when composite is in the middle band", () => {
    const md = renderEvalMarkdown(fakeRun({ composite_mean: 0.7 }));
    expect(md).toContain(":warning: composite < 0.85");
  });

  it("headline shows :x: when composite is below 0.65", () => {
    const md = renderEvalMarkdown(fakeRun({ composite_mean: 0.4 }));
    expect(md).toContain(":x: composite < 0.65");
  });

  it("escapes HTML-unsafe characters in fixture_id", () => {
    const run = fakeRun({
      cases: [
        {
          ...fakeRun().cases[0]!,
          fixture_id: "<script>alert(1)</script>",
        },
      ],
    });
    const md = renderEvalMarkdown(run);
    expect(md).not.toContain("<script>");
    expect(md).toContain("&lt;script&gt;");
  });

  it("renders 0-case run with 'no fixtures' headline", () => {
    const md = renderEvalMarkdown(fakeRun({ cases: [], composite_mean: 0 }));
    expect(md).toContain("0 fixture(s)");
    expect(md).toContain("no fixtures");
  });
});

// -------------------------------------------------------------------
// GitHub API plumbing
// -------------------------------------------------------------------

interface FakeComment {
  id: number;
  body: string;
}

class FakeGithub {
  comments: FakeComment[] = [];
  events: Array<[string, number]> = [];
  nextId = 1001;
  apiBase = "http://fake-github.local";

  fetch = async (
    url: string,
    init: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> => {
    const method = (init.method as string) ?? "GET";
    const headers = (init.headers as Record<string, string>) ?? {};
    if (!(headers.Authorization ?? "").startsWith("Bearer ")) {
      return { ok: false, status: 401, text: async () => "no token", json: async () => ({ message: "no token" }) };
    }
    const u = new URL(url);
    if (method === "GET" && u.pathname.endsWith("/comments")) {
      const body = JSON.stringify(this.comments);
      return { ok: true, status: 200, text: async () => body, json: async () => this.comments };
    }
    if (method === "POST" && u.pathname.endsWith("/comments")) {
      const body = JSON.parse((init.body as string) ?? "{}") as { body: string };
      const c: FakeComment = { id: this.nextId++, body: body.body };
      this.comments.push(c);
      this.events.push(["POST", c.id]);
      const out = JSON.stringify(c);
      return { ok: true, status: 201, text: async () => out, json: async () => c };
    }
    if (method === "PATCH") {
      const parts = u.pathname.split("/");
      const id = Number(parts[parts.length - 1]);
      const body = JSON.parse((init.body as string) ?? "{}") as { body: string };
      const found = this.comments.find((c) => c.id === id);
      if (!found) {
        return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
      }
      found.body = body.body;
      this.events.push(["PATCH", id]);
      const out = JSON.stringify(found);
      return { ok: true, status: 200, text: async () => out, json: async () => found };
    }
    return { ok: false, status: 404, text: async () => "no route", json: async () => ({}) };
  };
}

describe("findStickyCommentId", () => {
  it("returns null when there are no comments", async () => {
    const gh = new FakeGithub();
    const id = await findStickyCommentId("o/r", 1, {
      token: "t",
      fetchImpl: gh.fetch as unknown as typeof fetch,
      apiBase: gh.apiBase,
    });
    expect(id).toBeNull();
  });

  it("finds the comment carrying the marker", async () => {
    const gh = new FakeGithub();
    gh.comments.push(
      { id: 1, body: "unrelated comment" },
      { id: 2, body: `prefix ${STICKY_MARKER} suffix` },
      { id: 3, body: "another" },
    );
    const id = await findStickyCommentId("o/r", 1, {
      token: "t",
      fetchImpl: gh.fetch as unknown as typeof fetch,
      apiBase: gh.apiBase,
    });
    expect(id).toBe(2);
  });
});

describe("upsertStickyComment", () => {
  it("POSTs when no prior comment exists", async () => {
    const gh = new FakeGithub();
    const id = await upsertStickyComment(
      "o/r",
      1,
      `${STICKY_MARKER}\nbody`,
      {
        token: "t",
        fetchImpl: gh.fetch as unknown as typeof fetch,
        apiBase: gh.apiBase,
      },
    );
    expect(id).toBe(1001);
    expect(gh.events).toEqual([["POST", 1001]]);
  });

  it("PATCHes the existing comment", async () => {
    const gh = new FakeGithub();
    gh.comments.push({ id: 42, body: `${STICKY_MARKER}\nold` });
    const id = await upsertStickyComment(
      "o/r",
      1,
      `${STICKY_MARKER}\nnew`,
      {
        token: "t",
        fetchImpl: gh.fetch as unknown as typeof fetch,
        apiBase: gh.apiBase,
      },
    );
    expect(id).toBe(42);
    expect(gh.events).toEqual([["PATCH", 42]]);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]?.body).toContain("new");
  });

  it("refuses to upsert a body that lacks the marker", async () => {
    const gh = new FakeGithub();
    await expect(
      upsertStickyComment("o/r", 1, "no marker here", {
        token: "t",
        fetchImpl: gh.fetch as unknown as typeof fetch,
        apiBase: gh.apiBase,
      }),
    ).rejects.toThrow(/missing the sticky marker/);
  });
});
