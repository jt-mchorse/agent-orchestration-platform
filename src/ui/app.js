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
      return `error: ${o.outcome.error.kind} — ${o.outcome.error.message}`;
    }
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

function eventClass(ev) {
  if (ev.kind === "observation") {
    return "event observation " + (ev.observation.outcome.kind === "ok" ? "ok" : "err");
  }
  return "event " + ev.kind;
}

function shortJson(v) {
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return String(v);
  }
}

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const m = hash.match(/^#run=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
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
  useEffect(() => {
    fetch("/api/runs/" + encodeURIComponent(runId))
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)),
      )
      .then(setRun)
      .catch((e) => setErr(e.message));
  }, [runId]);
  if (err) return html`<div class="empty">Failed to load run: ${err}</div>`;
  if (!run) return html`<div class="empty">Loading…</div>`;
  return html`
    <div class="nav"><a onClick=${onBack}>← runs</a> · <span class="crumb">${run.run_id}</span></div>
    <h2>${run.pr.owner}/${run.pr.repo}#${run.pr.number}</h2>
    <div class="review">
      <div class="summary">${run.summary || "(no summary)"}</div>
      ${run.recommendation
        ? html`<div class=${"reco reco-" + run.recommendation}>${recoLabel(run.recommendation)}</div>`
        : null}
      <div style="margin-top: 10px; font-size: 12px; color: var(--muted);">
        Status: <span class=${"status-" + run.status}>${run.status}</span> ·
        Started ${fmtTs(run.started_at)} ·
        Finalized ${fmtTs(run.finalized_at)} ·
        ${run.total_cost.input_tokens}/${run.total_cost.output_tokens} tokens ·
        ${fmtDollars(run.total_cost.dollars)}
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
  return runId ? html`<${RunDetail} runId=${runId} onBack=${onBack} />` : html`<${RunList} onPick=${onPick} />`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
