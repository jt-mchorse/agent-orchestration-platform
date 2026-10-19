// React-via-ESM-CDN trace viewer (#6).
//
// Loaded as a bare <script type="module"> from index.html with an
// import map pointing react/react-dom/client/htm at esm.sh. No
// bundler, no npm-side react surface — same dep-discipline reasoning
// as the stdlib http.server on the backend.
//
// Two screens:
//   1. RunList — list of run summaries with cost columns; clicking one
//      pushes a `#run=<id>` hash and switches to detail.
//   2. RunDetail — review card on top, chronological timeline below.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";

const html = htm.bind(React.createElement);

function fmtDollars(d) {
  if (typeof d !== "number" || !Number.isFinite(d)) return "—";
  if (d === 0) return "$0.00";
  if (d < 0.01) return "<$0.01";
  return "$" + d.toFixed(2);
}

function fmtTs(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function recoLabel(reco) {
  if (!reco) return "no recommendation";
  return reco.replace(/_/g, " ");
}

function eventBody(ev) {
  switch (ev.kind) {
    case "run_started":
      return `pr: ${ev.pr.owner}/${ev.pr.repo}#${ev.pr.number}`;
    case "plan_emitted":
      return `v${ev.version} · goal: ${ev.plan.goal} · ${ev.plan.steps.length} step(s)`;
    case "step_started":
      return `[${ev.index}] tool: ${ev.step.tool} · rationale: ${ev.step.rationale}`;
    case "observation": {
      const o = ev.observation;
      if (o.outcome.kind === "ok") return `ok: ${o.step.tool} → ${shortJson(o.outcome.value)}`;
      return `error: ${errorLine(o.outcome.error)}`;
    }
    // The recovery events #5 added (#225). They fell to `default`, whose
    // 120-char JSON cut spent its budget on `ts` and `kind` and ended inside
    // `error`, so the message these events exist to record never showed.
    case "retry_attempted":
      return `${ev.toolName} attempt ${ev.attempt} failed, retrying in ${ev.backoffMs}ms · error: ${errorLine(ev.error)}`;
    case "fallback_used":
      return `${ev.from} → ${ev.to} · error: ${errorLine(ev.error)}`;
    case "re_plan_triggered":
      return `${ev.reason.kind}: ${ev.reason.toolName}`;
    case "finalized":
      return `reco: ${recoLabel(ev.review.recommendation)} · ${ev.review.findings.length} finding(s)`;
    case "aborted":
      return `reason: ${ev.reason}`;
    default:
      return shortJson(ev);
  }
}

function errorLine(error) {
  return `${error.kind} — ${error.message}`;
}

function eventClass(ev) {
  if (ev.kind === "observation") {
    return "event observation " + (ev.observation.outcome.kind === "ok" ? "ok" : "err");
  }
  return "event " + ev.kind;
}

// The cut lands on a code-point boundary (#233): slicing at a fixed UTF-16
// offset can split a surrogate pair, and the lone high half renders as U+FFFD
// before the "...". Same rule as `sliceCodeUnits` in src/tools/search-repo.ts
// (#215), inlined because this file loads from a CDN and cannot import it.
function shortJson(v) {
  try {
    const s = JSON.stringify(v);
    if (s.length <= 120) return s;
    const last = s.charCodeAt(116);
    const next = s.charCodeAt(117);
    const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    return s.slice(0, splitsPair ? 116 : 117) + "...";
  } catch {
    return String(v);
  }
}

// The run id a `#run=<id>` hash names, or null for any other hash.
//
// Decoded under a guard (#223). A hand-typed malformed escape (`#run=%`, `%ZZ`,
// a truncated UTF-8 sequence) made `decodeURIComponent` throw `URIError` during
// render, and with no error boundary that blanked the whole app. #155 fixed the
// same throw on the server and settled the answer: a malformed id names no run.
// So the raw capture is kept as the id; `RunDetail` encodes it, the server
// decodes it back, and the screen shows its ordinary "HTTP 404".
function runIdFromHash(hash) {
  const m = hash.match(/^#run=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return runIdFromHash(hash);
}

function RunList({ onPick }) {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetch("/api/runs?limit=50")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((data) => setRuns(data.runs))
      .catch((e) => setErr(e.message));
  }, []);
  if (err) return html`<div class="empty">Failed to load runs: ${err}</div>`;
  if (!runs) return html`<div class="empty">Loading…</div>`;
  if (runs.length === 0) return html`<div class="empty">No runs persisted yet.</div>`;
  return html`
    <h2>Runs (${runs.length})</h2>
    <table class="runs-table">
      <thead>
        <tr>
          <th>PR</th>
          <th>Status</th>
          <th>Recommendation</th>
          <th>Started</th>
          <th class="cost">In/Out tokens</th>
          <th class="cost">Cost</th>
        </tr>
      </thead>
      <tbody>
        ${runs.map(
          (r) => html`
            <tr key=${r.run_id} onClick=${() => onPick(r.run_id)}>
              <td>${r.pr.owner}/${r.pr.repo}#${r.pr.number}</td>
              <td><span class=${"status-" + r.status}>${r.status}</span></td>
              <td>${recoLabel(r.recommendation)}</td>
              <td>${fmtTs(r.started_at)}</td>
              <td class="tokens">${r.total_cost.input_tokens} / ${r.total_cost.output_tokens}</td>
              <td class="cost">${fmtDollars(r.total_cost.dollars)}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
}

function RunDetail({ runId, onBack }) {
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  // A response for a run this screen no longer shows is dropped (#229). The
  // effect re-ran on a hash change but nothing reset `err`, and the previous
  // run's fetch could resolve last: after `#run=missing` -> `#run=good` the
  // page still read "Failed to load run: HTTP 404", and a slow response for
  // the old run replaced the new one while the URL named the new one. `App`
  // also keys this component by `runId`, so each run starts from empty state.
  useEffect(() => {
    let current = true;
    fetch("/api/runs/" + encodeURIComponent(runId))
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)),
      )
      .then((body) => {
        if (current) setRun(body);
      })
      .catch((e) => {
        if (current) setErr(e.message);
      });
    return () => {
      current = false;
    };
  }, [runId]);
  if (err) return html`<div class="empty">Failed to load run: ${err}</div>`;
  if (!run) return html`<div class="empty">Loading…</div>`;
  // Styling goes in index.html's classes, never an inline `style="..."` (#221).
  // htm passes that attribute through as a string, React accepts only an object
  // for `style` and throws #62, and with no error boundary the throw unmounted
  // the app: this screen was blank for every run that loaded.
  // Never end a text line just before a line that starts with `${...}` (#227).
  // htm trims newline-bearing whitespace at both ends of every text chunk, so
  // "· \n ${x}" renders as "·x": the status line read "·1200/300 tokens ·$0.02".
  return html`
    <div class="nav"><a onClick=${onBack}>← runs</a> · <span class="crumb">${run.run_id}</span></div>
    <h2>${run.pr.owner}/${run.pr.repo}#${run.pr.number}</h2>
    <div class="review">
      <div class="summary">${run.summary || "(no summary)"}</div>
      ${run.recommendation
        ? html`<div class=${"reco reco-" + run.recommendation}>${recoLabel(run.recommendation)}</div>`
        : null}
      <div class="meta">
        Status: <span class=${"status-" + run.status}>${run.status}</span> ·
        Started ${fmtTs(run.started_at)} ·
        Finalized ${fmtTs(run.finalized_at)} · ${run.total_cost.input_tokens}/${run.total_cost.output_tokens} tokens · ${fmtDollars(run.total_cost.dollars)}
      </div>
    </div>
    <h2>Timeline (${run.events.length})</h2>
    <div class="timeline">
      ${run.events.map(
        (ev, i) => html`
          <div key=${i} class=${eventClass(ev)}>
            <div class="head">
              <span class="kind">${ev.kind}</span>
              <span class="ts">${ev.ts}</span>
            </div>
            <div class="body"><code>${eventBody(ev)}</code></div>
          </div>
        `,
      )}
    </div>
  `;
}

function App() {
  const runId = useHashRoute();
  const onPick = (id) => {
    window.location.hash = "run=" + encodeURIComponent(id);
  };
  const onBack = () => {
    window.location.hash = "";
  };
  return runId
    ? html`<${RunDetail} key=${runId} runId=${runId} onBack=${onBack} />`
    : html`<${RunList} onPick=${onPick} />`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
