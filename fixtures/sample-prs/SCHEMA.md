# Sample-PR fixture schema (v1)

Each fixture in this directory is a single JSON file capturing one real PR
from the `jt-mchorse/*` portfolio. The fixture is the **input** the agent
consumes; downstream issues (#3 planner, #4 HITL, #6 trace UI, #7 evals) all
read these files instead of hitting the GitHub API at run time, so tests stay
hermetic and replays stay reproducible.

## Why JSON, not raw `.diff`

The agent needs three things — PR metadata (title, body, base/head,
additions/deletions/changed_files), per-file change info (status,
additions/deletions, patch), and provenance (which repo, which PR number) —
in one envelope. A `.diff` gives only the patch. JSON keeps the schema
explicit and version-able.

## Why two fixtures, not one

The two committed fixtures cover **distinct review surfaces** so a future
eval suite (#7) can score the agent on both:

- `vector-search-at-scale_pr6_terraform_infra.json` — infrastructure-as-code
  PR (Terraform HCL, shell scripts, Makefile, CI workflow). Reviewer should
  catch IAM-blast-radius mistakes, hard-coded CIDRs, and cost-impact issues.
- `rag-production-kit_pr9_hybrid_retrieval.json` — Python implementation PR
  (`psycopg`, pgvector, BM25+vector fusion, integration tests). Reviewer
  should catch API-shape regressions, missing tests, and faithfulness-of-
  benchmarks claims.

Both PRs have since merged, so the "what did human reviewers actually flag"
ground truth is recoverable from the GitHub thread. The vector-search-at-scale
fixture was captured while its PR was still open, and it records `state: "open"`,
`merged: false`; the fixture is the PR as captured, not as merged. (#165)

## Schema (v1)

```json
{
  "schema_version": "1",
  "source": "github",
  "repo": "jt-mchorse/<repo-name>",
  "pr": {
    "number": <int>,
    "title": "<string>",
    "body": "<markdown>",
    "state": "open|closed",
    "merged": <bool>,
    "base": "<branch ref>",
    "head": "<branch ref>",
    "additions": <int>,
    "deletions": <int>,
    "changed_files": <int>,
    "html_url": "<url>",
    "created_at": "<ISO-8601>"
  },
  "files": [
    {
      "filename": "<path>",
      "status": "added|modified|removed|renamed",
      "additions": <int>,
      "deletions": <int>,
      "changes": <int>,
      "patch": "<unified-diff hunk(s), or null if binary/large>"
    }
  ]
}
```

Some `patch` values may be `null` for binary files or files where GitHub's
API truncates the patch. The agent must handle both cases.

## Capture command

To add a new fixture from a real PR:

```bash
gh api repos/<owner>/<repo>/pulls/<N> \
  --jq '{number, title, body, state, merged, base: .base.ref, head: .head.ref, additions, deletions, changed_files, html_url, created_at}' \
  > /tmp/pr.json
gh api repos/<owner>/<repo>/pulls/<N>/files --paginate \
  --jq '[.[] | {filename, status, additions, deletions, changes, patch}]' > /tmp/files.json
jq -s '{schema_version: "1", source: "github", repo: "<owner>/<repo>", pr: .[0], files: (.[1:] | add)}' \
  /tmp/pr.json /tmp/files.json > fixtures/sample-prs/<slug>.json
npm run validate -- fixtures/sample-prs/<slug>.json
```

The PR shape is spelled out here because the raw API object fails validation:
its `base` and `head` are objects, and the schema wants the branch refs
(`pr.base must be a string, got object`). This text used to say the shape
lived in `docs/use-case.md`; it never did. `--paginate` prints one array per
page, so the files are `(.[1:] | add)`, all pages, not `.[1]`, the first
page only. With `?per_page=10` a 35-file PR kept 10. (#165)
