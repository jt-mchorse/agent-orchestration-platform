/**
 * Collecting-mode lint for eval-runner inputs (issue #39).
 *
 * `src/eval/runner.ts` reads each `fixture_path` and `golden_path` with
 * fail-fast `JSON.parse`: the first malformed file, missing field, or
 * wrong-type value aborts the eval run partway through. An operator who
 * hand-edits a fixture (an invited workflow per
 * `fixtures/sample-prs/SCHEMA.md`) sees one error per `npm run eval`
 * attempt: fix, retry, fix, retry.
 *
 * This module is the pre-flight: `validateFixture(path)` and
 * `validateGolden(path)` walk the JSON in collecting mode and return
 * every finding in one pass. Same posture as the Python sister
 * validators in llm-eval-harness (#56/#57), prompt-regression-suite
 * (#49/#50), embedding-model-shootout (#45/#46), and
 * chunking-strategies-lab (#37/#38) — first TypeScript port.
 *
 * The shape divergence from the Python port: inputs here are single-JSON
 * documents, not JSONL, so a 1-indexed `lineNo` doesn't carry useful
 * information. Findings carry a `jsonPath` (e.g., `pr.number`,
 * `files[0].filename`) instead — that's what the operator actually
 * needs to locate the problem.
 */

import { promises as fs } from "node:fs";

/** One row-level (single-JSON-document, single-finding) issue. */
export interface ValidationFinding {
  readonly code: string;
  readonly reason: string;
  /** Dotted path into the JSON document, e.g., `pr.number`, `files[0].patch`. */
  readonly jsonPath: string;
}

/** Result of walking one JSON file in collecting mode. */
export interface ValidationReport {
  readonly path: string;
  readonly ok: boolean;
  readonly findings: readonly ValidationFinding[];
  /** Present on fixture reports. */
  readonly schemaVersion?: string;
  /** Present on golden reports, when the recommendation field validated. */
  readonly recommendation?: string;
}

const SUPPORTED_SCHEMA_VERSION = "1";
const VALID_RECOMMENDATIONS = new Set([
  "request_changes",
  "approve_with_comments",
  "approve",
]);
const VALID_FINDING_SEVERITIES = new Set(["blocker", "concern", "nit", "praise"]);
const VALID_FILE_STATUSES = new Set(["added", "modified", "removed", "renamed"]);
const REPO_FORMAT = /^[^/\s]+\/[^/\s]+$/;

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Walk a fixture JSON file in collecting mode. See module docstring. */
export async function validateFixture(filePath: string): Promise<ValidationReport> {
  const { obj, parseFinding } = await _readJson(filePath);
  if (parseFinding) {
    return _freezeReport({
      path: filePath,
      ok: false,
      findings: [parseFinding],
    });
  }
  const findings: ValidationFinding[] = [];
  let schemaVersion: string | undefined;
  if (!_isObject(obj)) {
    findings.push({
      code: "not_an_object",
      reason: "top-level value must be a JSON object",
      jsonPath: "$",
    });
    return _freezeReport({ path: filePath, ok: false, findings });
  }
  schemaVersion = _validateFixtureSchema(obj, findings);
  const ok = findings.length === 0;
  const base: ValidationReport = { path: filePath, ok, findings };
  return _freezeReport(schemaVersion !== undefined ? { ...base, schemaVersion } : base);
}

/** Walk a golden JSON file in collecting mode. See module docstring. */
export async function validateGolden(filePath: string): Promise<ValidationReport> {
  const { obj, parseFinding } = await _readJson(filePath);
  if (parseFinding) {
    return _freezeReport({
      path: filePath,
      ok: false,
      findings: [parseFinding],
    });
  }
  const findings: ValidationFinding[] = [];
  let recommendation: string | undefined;
  if (!_isObject(obj)) {
    findings.push({
      code: "not_an_object",
      reason: "top-level value must be a JSON object",
      jsonPath: "$",
    });
    return _freezeReport({ path: filePath, ok: false, findings });
  }
  recommendation = _validateGoldenSchema(obj, findings);
  const ok = findings.length === 0;
  const base: ValidationReport = { path: filePath, ok, findings };
  return _freezeReport(recommendation !== undefined ? { ...base, recommendation } : base);
}

// ---------------------------------------------------------------------------
// Schema walkers
// ---------------------------------------------------------------------------

function _validateFixtureSchema(
  obj: Record<string, unknown>,
  findings: ValidationFinding[],
): string | undefined {
  // 1. schema_version
  const sv = obj["schema_version"];
  let schemaVersion: string | undefined;
  if (sv === undefined) {
    findings.push({
      code: "missing_schema_version",
      reason: "fixture must declare schema_version",
      jsonPath: "schema_version",
    });
  } else if (typeof sv !== "string") {
    findings.push({
      code: "non_string_schema_version",
      reason: `schema_version must be a string, got ${_typeName(sv)}`,
      jsonPath: "schema_version",
    });
  } else if (sv !== SUPPORTED_SCHEMA_VERSION) {
    findings.push({
      code: "wrong_schema_version",
      reason: `schema_version ${_quote(sv)} is not supported; this validator pins ${_quote(SUPPORTED_SCHEMA_VERSION)}`,
      jsonPath: "schema_version",
    });
  } else {
    schemaVersion = sv;
  }
  // 2. source
  _requireString(obj, "source", findings);
  // 3. repo (must be owner/name)
  const repo = obj["repo"];
  if (repo === undefined) {
    findings.push({
      code: "missing_repo",
      reason: "fixture must declare repo",
      jsonPath: "repo",
    });
  } else if (typeof repo !== "string") {
    findings.push({
      code: "non_string_repo",
      reason: `repo must be a string, got ${_typeName(repo)}`,
      jsonPath: "repo",
    });
  } else if (!REPO_FORMAT.test(repo)) {
    findings.push({
      code: "repo_format",
      reason: `repo ${_quote(repo)} must match 'owner/name' (got non-conforming string)`,
      jsonPath: "repo",
    });
  }
  // 4. pr object
  const pr = obj["pr"];
  if (pr === undefined) {
    findings.push({
      code: "missing_pr",
      reason: "fixture must declare pr",
      jsonPath: "pr",
    });
  } else if (!_isObject(pr)) {
    findings.push({
      code: "non_object_pr",
      reason: `pr must be an object, got ${_typeName(pr)}`,
      jsonPath: "pr",
    });
  } else {
    _validatePrObject(pr, findings);
  }
  // 5. files array
  const files = obj["files"];
  if (files === undefined) {
    findings.push({
      code: "missing_files",
      reason: "fixture must declare files",
      jsonPath: "files",
    });
  } else if (!Array.isArray(files)) {
    findings.push({
      code: "non_array_files",
      reason: `files must be an array, got ${_typeName(files)}`,
      jsonPath: "files",
    });
  } else if (files.length === 0) {
    findings.push({
      code: "files_empty",
      reason: "files array must contain at least one entry",
      jsonPath: "files",
    });
  } else {
    for (let i = 0; i < files.length; i++) {
      _validateFileEntry(files[i], i, findings);
    }
  }
  return schemaVersion;
}

function _validatePrObject(pr: Record<string, unknown>, findings: ValidationFinding[]): void {
  // pr.number is 1-based (fetch_pr requires `.positive()`), so it gets min=1;
  // the count fields are >= 0.
  _requireFiniteInteger(pr, "number", "pr", findings, 1);
  for (const field of ["additions", "deletions", "changed_files"] as const) {
    _requireFiniteInteger(pr, field, "pr", findings);
  }
  // String fields: title, body, state, base, head, html_url, created_at.
  for (const field of ["title", "body", "state", "base", "head", "html_url", "created_at"] as const) {
    _requireString(pr, field, findings, "pr");
  }
  // Boolean: merged.
  const merged = pr["merged"];
  if (merged === undefined) {
    findings.push({
      code: "pr.merged_missing",
      reason: "pr.merged is required",
      jsonPath: "pr.merged",
    });
  } else if (typeof merged !== "boolean") {
    findings.push({
      code: "pr.merged_wrong_type",
      reason: `pr.merged must be a boolean, got ${_typeName(merged)}`,
      jsonPath: "pr.merged",
    });
  }
}

function _validateFileEntry(entry: unknown, index: number, findings: ValidationFinding[]): void {
  const here = `files[${index}]`;
  if (!_isObject(entry)) {
    findings.push({
      code: `files[${index}]_not_an_object`,
      reason: `${here} must be an object, got ${_typeName(entry)}`,
      jsonPath: here,
    });
    return;
  }
  _requireString(entry, "filename", findings, here);
  const status = entry["status"];
  if (status === undefined) {
    findings.push({
      code: `${here}.status_missing`,
      reason: `${here}.status is required`,
      jsonPath: `${here}.status`,
    });
  } else if (typeof status !== "string") {
    findings.push({
      code: `${here}.status_wrong_type`,
      reason: `${here}.status must be a string, got ${_typeName(status)}`,
      jsonPath: `${here}.status`,
    });
  } else if (!VALID_FILE_STATUSES.has(status)) {
    findings.push({
      code: `${here}.status_wrong_value`,
      reason: `${here}.status ${_quote(status)} not in {added, modified, removed, renamed}`,
      jsonPath: `${here}.status`,
    });
  }
  for (const field of ["additions", "deletions", "changes"] as const) {
    _requireFiniteInteger(entry, field, here, findings);
  }
  // patch may be string OR null (binary/large files); both are accepted,
  // but anything else is wrong.
  const patch = entry["patch"];
  if (patch === undefined) {
    findings.push({
      code: `${here}.patch_missing`,
      reason: `${here}.patch is required (use null for binary/large files)`,
      jsonPath: `${here}.patch`,
    });
  } else if (patch !== null && typeof patch !== "string") {
    findings.push({
      code: `${here}.patch_wrong_type`,
      reason: `${here}.patch must be a string or null, got ${_typeName(patch)}`,
      jsonPath: `${here}.patch`,
    });
  }
}

function _validateGoldenSchema(
  obj: Record<string, unknown>,
  findings: ValidationFinding[],
): string | undefined {
  const review = obj["golden_review"];
  if (review === undefined) {
    findings.push({
      code: "missing_golden_review",
      reason: "golden must declare golden_review",
      jsonPath: "golden_review",
    });
    return undefined;
  }
  if (!_isObject(review)) {
    findings.push({
      code: "non_object_golden_review",
      reason: `golden_review must be an object, got ${_typeName(review)}`,
      jsonPath: "golden_review",
    });
    return undefined;
  }
  _requireString(review, "summary", findings, "golden_review");
  // recommendation must be in the enum.
  let recommendation: string | undefined;
  const reco = review["recommendation"];
  if (reco === undefined) {
    findings.push({
      code: "golden_review.recommendation_missing",
      reason: "golden_review.recommendation is required",
      jsonPath: "golden_review.recommendation",
    });
  } else if (typeof reco !== "string") {
    findings.push({
      code: "golden_review.recommendation_wrong_type",
      reason: `golden_review.recommendation must be a string, got ${_typeName(reco)}`,
      jsonPath: "golden_review.recommendation",
    });
  } else if (!VALID_RECOMMENDATIONS.has(reco)) {
    findings.push({
      code: "recommendation_wrong_value",
      reason: `golden_review.recommendation ${_quote(reco)} not in {request_changes, approve_with_comments, approve}`,
      jsonPath: "golden_review.recommendation",
    });
  } else {
    recommendation = reco;
  }
  // findings array.
  const fs_ = review["findings"];
  if (fs_ === undefined) {
    findings.push({
      code: "golden_review.findings_missing",
      reason: "golden_review.findings is required",
      jsonPath: "golden_review.findings",
    });
  } else if (!Array.isArray(fs_)) {
    findings.push({
      code: "findings_not_array",
      reason: `golden_review.findings must be an array, got ${_typeName(fs_)}`,
      jsonPath: "golden_review.findings",
    });
  } else {
    for (let i = 0; i < fs_.length; i++) {
      _validateFindingEntry(fs_[i], i, findings);
    }
  }
  return recommendation;
}

function _validateFindingEntry(entry: unknown, index: number, findings: ValidationFinding[]): void {
  const here = `golden_review.findings[${index}]`;
  if (!_isObject(entry)) {
    findings.push({
      code: `${here}_not_an_object`,
      reason: `${here} must be an object, got ${_typeName(entry)}`,
      jsonPath: here,
    });
    return;
  }
  const sev = entry["severity"];
  if (sev === undefined) {
    findings.push({
      code: `${here}.severity_missing`,
      reason: `${here}.severity is required`,
      jsonPath: `${here}.severity`,
    });
  } else if (typeof sev !== "string") {
    findings.push({
      code: `${here}.severity_wrong_type`,
      reason: `${here}.severity must be a string, got ${_typeName(sev)}`,
      jsonPath: `${here}.severity`,
    });
  } else if (!VALID_FINDING_SEVERITIES.has(sev)) {
    findings.push({
      code: `${here}.severity_wrong_value`,
      reason: `${here}.severity ${_quote(sev)} not in {blocker, concern, nit, praise}`,
      jsonPath: `${here}.severity`,
    });
  }
  _requireString(entry, "message", findings, here);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function _readJson(
  filePath: string,
): Promise<{ obj: unknown; parseFinding: ValidationFinding | null }> {
  const text = await fs.readFile(filePath, "utf-8");
  try {
    return { obj: JSON.parse(text), parseFinding: null };
  } catch (err) {
    return {
      obj: null,
      parseFinding: {
        code: "malformed_json",
        reason: `invalid JSON: ${(err as Error).message}`,
        jsonPath: "$",
      },
    };
  }
}

function _requireString(
  obj: Record<string, unknown>,
  field: string,
  findings: ValidationFinding[],
  prefix?: string,
): void {
  const here = prefix ? `${prefix}.${field}` : field;
  const value = obj[field];
  if (value === undefined) {
    findings.push({
      code: prefix ? `${prefix}.${field}_missing` : `missing_${field}`,
      reason: `${here} is required`,
      jsonPath: here,
    });
    return;
  }
  if (typeof value !== "string") {
    findings.push({
      code: prefix ? `${prefix}.${field}_wrong_type` : `non_string_${field}`,
      reason: `${here} must be a string, got ${_typeName(value)}`,
      jsonPath: here,
    });
  }
}

function _requireFiniteInteger(
  obj: Record<string, unknown>,
  field: string,
  prefix: string,
  findings: ValidationFinding[],
  min = 0,
): void {
  const here = `${prefix}.${field}`;
  const value = obj[field];
  if (value === undefined) {
    findings.push({
      code: `${prefix}.${field}_missing`,
      reason: `${here} is required`,
      jsonPath: here,
    });
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    findings.push({
      code: `${prefix}.${field}_wrong_type`,
      reason: `${here} must be a finite integer, got ${_typeName(value)}`,
      jsonPath: here,
    });
    return;
  }
  // Fields routed through this helper are counts: pr.number (>= 1),
  // additions / deletions / changed_files / changes (>= 0). A negative value is
  // corruption (a bad GitHub-API transform, a hand-edited fixture) that would
  // otherwise pass the gate and flow into evaluateAll, producing a nonsensical
  // review summary. Reject it loudly — same entry-validation posture as #29/#31.
  if (value < 0) {
    findings.push({
      code: `${prefix}.${field}_negative`,
      reason: `${here} must be non-negative, got ${value}`,
      jsonPath: here,
    });
    return;
  }
  // A field with `min >= 1` (pr.number) is 1-based: 0 is non-negative but still
  // invalid. fetch_pr/post_review_comment type `number` as `z.number().int()
  // .positive()`, so a 0 here passes this pre-flight lint yet the eval run
  // rejects it the moment fetch_pr is called (#71). Catch it here instead, where
  // it's cheap, rather than letting a "clean" fixture blow up mid-run.
  if (value < min) {
    findings.push({
      code: `${prefix}.${field}_out_of_range`,
      reason: `${here} must be at least ${min}, got ${value}`,
      jsonPath: here,
    });
  }
}

function _isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function _quote(value: string): string {
  return JSON.stringify(value);
}

function _freezeReport(report: ValidationReport): ValidationReport {
  // Freeze findings tuple-style so callers can't mutate the report; the
  // shape matches the Python `frozen=True` dataclass pattern.
  return Object.freeze({
    ...report,
    findings: Object.freeze([...report.findings]),
  });
}

// ---------------------------------------------------------------------------
// CLI entry — invoked by `src/bin/validate.ts`.
// ---------------------------------------------------------------------------

/** Render a `ValidationReport` as human-readable lines and a totals line. */
export function renderReportHuman(report: ValidationReport): { stdout: string; stderr: string } {
  const stderrLines: string[] = [];
  for (const f of report.findings) {
    stderrLines.push(`[${f.code}] at ${f.jsonPath}: ${f.reason}`);
  }
  const status = report.ok ? "ok" : "fail";
  const extras: string[] = [];
  if (report.schemaVersion) extras.push(`schema_version=${report.schemaVersion}`);
  if (report.recommendation) extras.push(`recommendation=${report.recommendation}`);
  const extrasStr = extras.length ? ` ${extras.join(" ")}` : "";
  return {
    stdout: `${status}: ${report.path} findings=${report.findings.length}${extrasStr}\n`,
    stderr: stderrLines.length ? stderrLines.join("\n") + "\n" : "",
  };
}

/** Render as JSON. */
export function renderReportJson(report: ValidationReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
