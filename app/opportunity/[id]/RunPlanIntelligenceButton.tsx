"use client";

import { useEffect, useState } from "react";

type Summary = {
  total_documents?: number;
  drawings?: number;
  specs?: number;
  tcb_sections?: number;
  spec_section_index?: number;
  readiness?: string;
  bid_stage?: string;
  schedules?: number;
  bid_form_csi?: number;
};

type GetState = {
  ok: true;
  has_run: boolean;
  generated_at: string | null;
  summary: Summary | null;
};

/**
 * RunPlanIntelligenceButton — kicks off the deterministic
 * plan-intelligence pass for this opp from the browser. Replaces the
 * CLI command `node scripts/plan-intelligence.js --opp=<id>`.
 *
 * This is the prerequisite for the coverage manifest. Order on the
 * page is intentional: this button → Run Coverage → takeoff. If
 * plan-intelligence hasn't run, coverage shows "must run plan
 * intelligence first."
 */
export function RunPlanIntelligenceButton({ oppId }: { oppId: string }) {
  const [state, setState] = useState<GetState | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastSummary, setLastSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/opportunities/${oppId}/plan-intelligence/run`)
      .then((r) => r.json())
      .then((body: GetState) => {
        if (!cancelled) setState(body);
      })
      .catch(() => {
        if (!cancelled) setState({ ok: true, has_run: false, generated_at: null, summary: null });
      });
    return () => { cancelled = true; };
  }, [oppId]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/opportunities/${oppId}/plan-intelligence/run`, { method: "POST" });
      const body = await res.json();
      if (res.ok && body.ok) {
        setLastSummary(body.summary);
        setState({ ok: true, has_run: true, generated_at: body.generated_at, summary: body.summary });
      } else {
        setError(body.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  const summary = lastSummary || state.summary;
  const label = state.has_run
    ? (busy ? "Re-running…" : "Re-run Plan Intelligence")
    : (busy ? "Running…" : "Run Plan Intelligence");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium disabled:opacity-50"
          title="Download every PDF on this opp, classify each (spec / drawing / Q&A / etc), extract sheet IDs + schedules + CSI section index. Prerequisite for Run Coverage."
        >
          {label}
        </button>
        {state.generated_at && (
          <span className="text-xs text-slate-500" title={`Generated ${new Date(state.generated_at).toLocaleString()}`}>
            ✓ {new Date(state.generated_at).toLocaleDateString()}
          </span>
        )}
      </div>
      {summary && (
        <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          <span className="font-medium">{summary.total_documents ?? 0}</span> docs ·{" "}
          <span className="font-medium">{summary.drawings ?? 0}</span> drawings ·{" "}
          <span className="font-medium">{summary.specs ?? 0}</span> specs ·{" "}
          <span className="font-medium">{summary.spec_section_index ?? 0}</span> CSI sections found
          {summary.readiness && (
            <> · readiness: <span className="font-medium">{summary.readiness.replace(/_/g, " ")}</span></>
          )}
        </div>
      )}
      {error && <span className="text-xs text-red-700 dark:text-red-400">✗ {error}</span>}
      {busy && (
        <span className="text-xs text-slate-500">
          Downloading PDFs and extracting — typically 30–90s for a full bid set.
        </span>
      )}
    </div>
  );
}
