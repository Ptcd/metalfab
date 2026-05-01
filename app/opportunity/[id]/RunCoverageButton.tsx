"use client";

import { useEffect, useState } from "react";

type Counts = {
  included: number;
  excluded: number;
  n_a: number;
  needs_human_judgment: number;
};

type Summary = {
  spec_sections: Counts;
  plan_sheets:   Counts;
  schedules:     Counts;
  needs_vision_count: number;
  unresolved_count: number;
};

type ManifestRow = {
  summary: Summary;
  unresolved_count: number;
  needs_vision_count: number;
  generated_at: string;
};

type GetState = {
  ok: true;
  manifest: ManifestRow | null;
  has_plan_intelligence: boolean;
  migration_missing: boolean;
};

/**
 * RunCoverageButton — one-click trigger for the coverage manifest
 * stage. The CLI equivalent is `node scripts/coverage.js --opp=<id>`,
 * but Colin doesn't run CLI, so this calls the same builder via
 * `POST /api/opportunities/[id]/coverage/run`.
 *
 * Renders one of three states:
 *   - "Apply migration first" — coverage_manifests table doesn't exist
 *   - "Run plan intelligence first" — no plan_intelligence digest yet
 *   - "Run coverage" / "Re-run coverage" — happy path
 *
 * After a run, shows a compact summary inline.
 */
export function RunCoverageButton({ oppId }: { oppId: string }) {
  const [state, setState] = useState<GetState | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/opportunities/${oppId}/coverage/run`)
      .then((r) => r.json())
      .then((body: GetState) => {
        if (!cancelled) setState(body);
      })
      .catch(() => {
        if (!cancelled) setState({ ok: true, manifest: null, has_plan_intelligence: false, migration_missing: false });
      });
    return () => { cancelled = true; };
  }, [oppId]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/opportunities/${oppId}/coverage/run`, { method: "POST" });
      const body = await res.json();
      if (res.ok && body.ok) {
        setLastRun(body.summary);
        setState((s) => s
          ? { ...s, manifest: { summary: body.summary, unresolved_count: body.unresolved_count, needs_vision_count: body.needs_vision_count, generated_at: new Date().toISOString() } }
          : s
        );
      } else {
        setError(body.error || `HTTP ${res.status}`);
        if (body.blocker === 'migration_missing' && state) {
          setState({ ...state, migration_missing: true });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  // Migration not applied — link out to the SQL.
  if (state.migration_missing) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled
          title="The coverage_manifests table doesn't exist yet — apply the migration in Supabase first."
          className="px-3 py-1.5 rounded-md bg-amber-100 text-amber-900 text-sm font-medium opacity-60 cursor-not-allowed dark:bg-amber-900/30 dark:text-amber-200"
        >
          ⚠ Apply migration first
        </button>
        <span className="text-xs text-slate-500">
          Open Supabase → SQL Editor, paste <code className="text-slate-700 dark:text-slate-300">supabase/migrations/017_coverage_manifests.sql</code>, hit Run. Then refresh.
        </span>
      </div>
    );
  }

  // Plan intelligence prerequisite missing.
  if (!state.has_plan_intelligence) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled
          title="Plan Intelligence hasn't run for this opportunity yet."
          className="px-3 py-1.5 rounded-md bg-slate-100 text-slate-500 text-sm font-medium opacity-60 cursor-not-allowed dark:bg-slate-800 dark:text-slate-400"
        >
          Run Coverage
        </button>
        <span className="text-xs text-slate-500">Plan Intelligence must run first.</span>
      </div>
    );
  }

  const summary = lastRun || state.manifest?.summary || null;
  const label = state.manifest ? (busy ? "Re-running…" : "Re-run Coverage") : (busy ? "Running…" : "Run Coverage");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-50"
          title="Build the coverage manifest: enumerate every spec section, plan sheet, and schedule; tag each as included/excluded/n-a/needs-review; flag thin-text sheets needing vision."
        >
          {label}
        </button>
        {state.manifest && (
          <span className="text-xs text-slate-500" title={`Generated ${new Date(state.manifest.generated_at).toLocaleString()}`}>
            ✓ {new Date(state.manifest.generated_at).toLocaleDateString()}
          </span>
        )}
      </div>
      {summary && (
        <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          <span className="font-medium">{summary.spec_sections.included}</span> spec sections in scope ·{" "}
          <span className="font-medium">{summary.plan_sheets.included}</span> plan sheets ·{" "}
          <span className="font-medium">{summary.schedules.included}</span> schedules
          {summary.needs_vision_count > 0 && (
            <> · <span className="text-amber-700 dark:text-amber-400 font-medium">{summary.needs_vision_count}</span> sheets need vision</>
          )}
          {summary.unresolved_count > 0 && (
            <> · <span className="text-amber-700 dark:text-amber-400 font-medium">{summary.unresolved_count}</span> need human review</>
          )}
        </div>
      )}
      {error && <span className="text-xs text-red-700 dark:text-red-400">✗ {error}</span>}
    </div>
  );
}
