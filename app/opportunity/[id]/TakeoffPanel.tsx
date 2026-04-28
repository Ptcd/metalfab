"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface ScenarioResult {
  label: 'conservative' | 'expected' | 'aggressive';
  total_weight_lbs: number;
  material_subtotal_usd: number;
  labor_subtotal_usd: number;
  finish_subtotal_usd: number;
  contingency_usd: number;
  subtotal_usd: number;
  overhead_usd: number;
  profit_usd: number;
  bid_total_usd: number;
  margin_percent: number;
}

interface TakeoffRun {
  id: string;
  stage: string;
  status: string;
  generated_at: string;
  total_weight_lbs: number | null;
  total_ironworker_hrs: number | null;
  bid_total_usd: number | null;
  confidence_avg: number | null;
  flagged_lines_count: number;
  notes: string | null;
}

interface TakeoffLine {
  line_no: number;
  category: string;
  description: string;
  quantity: number;
  quantity_unit: string;
  total_weight_lbs: number | null;
  ironworker_hrs: number | null;
  finish: string | null;
  line_total_usd: number | null;
  confidence: number;
  flagged_for_review: boolean;
  assumptions: string | null;
}

interface AuditFinding {
  severity: 'error' | 'warning' | 'info';
  category: string;
  finding: string;
  recommendation: string | null;
  related_takeoff_line: number | null;
  source_section: string | null;
  source_page: number | null;
}

interface AuditRow {
  id: string;
  verdict: 'passed' | 'review_recommended' | 'block_submission';
  errors_count: number;
  warnings_count: number;
  info_count: number;
  findings: AuditFinding[];
  missing_items: { category: string; description: string }[];
}

interface TakeoffData {
  run: TakeoffRun;
  lines: TakeoffLine[];
  audit: AuditRow | null;
  scenarios: {
    conservative: ScenarioResult;
    expected: ScenarioResult;
    aggressive: ScenarioResult;
  };
}

const fmt$ = (v: number | null | undefined) =>
  v == null ? '—' : `$${Math.round(v).toLocaleString()}`;

const VERDICT_STYLE: Record<string, string> = {
  passed: 'bg-green-100 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-200',
  review_recommended: 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-200',
  block_submission: 'bg-red-100 text-red-900 border-red-300 dark:bg-red-900/30 dark:text-red-200',
};

const SEVERITY_STYLE: Record<string, string> = {
  error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  info: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

export function TakeoffPanel({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [data, setData] = useState<TakeoffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [selected, setSelected] = useState<'conservative' | 'expected' | 'aggressive'>('expected');

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch(`/api/opportunities/${opportunityId}/takeoff`);
      const body = await res.json().catch(() => ({}));
      if (active) {
        setData(body.data);
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [opportunityId]);

  if (loading) return <div className="text-sm text-slate-500 italic">Loading takeoff…</div>;
  if (!data) return null;
  const { run, lines, audit, scenarios } = data;

  async function approve() {
    if (!data) return;
    setApproving(true);
    const bid = data.scenarios[selected].bid_total_usd;
    const res = await fetch(`/api/opportunities/${opportunityId}/takeoff/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: run.id, scenario: selected, bid_total_usd: bid }),
    });
    setApproving(false);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert(`Approve failed: ${e.error || res.status}`);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Takeoff</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Stage: <span className="font-medium">{run.stage}</span>
            {' · '}status: <span className="font-medium">{run.status}</span>
            {' · '}{lines.length} line items
            {run.total_weight_lbs != null && ` · ${Math.round(run.total_weight_lbs)} lbs`}
            {run.confidence_avg != null && ` · ${Math.round(run.confidence_avg * 100)}% avg confidence`}
            {run.flagged_lines_count > 0 && ` · ${run.flagged_lines_count} flagged`}
          </p>
        </div>
        {audit && (
          <span className={`text-xs font-semibold px-3 py-1 rounded-full border ${VERDICT_STYLE[audit.verdict] || ''}`}>
            Audit: {audit.verdict.replace('_', ' ')}
            {audit.errors_count > 0 && ` · ${audit.errors_count} err`}
            {audit.warnings_count > 0 && ` · ${audit.warnings_count} warn`}
          </span>
        )}
      </div>

      {/* Three scenarios */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(['conservative', 'expected', 'aggressive'] as const).map((k) => {
          const s = scenarios[k];
          const isSel = selected === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setSelected(k)}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                isSel
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
              }`}
            >
              <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">{k}</div>
              <div className="text-2xl font-bold text-slate-900 dark:text-white">{fmt$(s.bid_total_usd)}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                margin {s.margin_percent.toFixed(1)}% · contingency {fmt$(s.contingency_usd)}
              </div>
              <dl className="mt-3 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                <div className="flex justify-between"><dt>Material</dt><dd>{fmt$(s.material_subtotal_usd)}</dd></div>
                <div className="flex justify-between"><dt>Labor</dt><dd>{fmt$(s.labor_subtotal_usd)}</dd></div>
                <div className="flex justify-between"><dt>Finish</dt><dd>{fmt$(s.finish_subtotal_usd)}</dd></div>
                <div className="flex justify-between"><dt>Subtotal</dt><dd>{fmt$(s.subtotal_usd)}</dd></div>
              </dl>
            </button>
          );
        })}
      </div>

      {/* Approve action */}
      {run.status !== 'approved' && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={approve}
            disabled={approving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded disabled:opacity-50"
          >
            {approving ? 'Approving…' : `Approve ${selected} (${fmt$(scenarios[selected].bid_total_usd)})`}
          </button>
          {audit?.verdict === 'block_submission' && (
            <span className="text-xs text-red-700 dark:text-red-300">
              ⚠ Audit verdict is <b>block submission</b> — resolve errors before approving.
            </span>
          )}
        </div>
      )}
      {run.status === 'approved' && (
        <div className="text-sm text-green-700 dark:text-green-300">
          ✓ Takeoff approved. Bid total: {fmt$(run.bid_total_usd)}.
        </div>
      )}

      {/* Audit findings */}
      {audit && audit.findings.length > 0 && (
        <details open className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-900 dark:text-white">
            Audit findings ({audit.findings.length})
          </summary>
          <ul className="mt-3 space-y-3">
            {audit.findings.map((f, i) => (
              <li key={i} className="flex gap-3">
                <span className={`shrink-0 inline-block px-2 py-0.5 rounded text-xs font-mono uppercase ${SEVERITY_STYLE[f.severity]}`}>
                  {f.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-900 dark:text-slate-100">
                    <span className="font-mono text-xs text-slate-500">{f.category}</span>
                    {f.related_takeoff_line && <span className="ml-2 text-xs text-slate-500">→ line {f.related_takeoff_line}</span>}
                    {f.source_section && <span className="ml-2 text-xs text-slate-500">@ {f.source_section}{f.source_page ? `, p${f.source_page}` : ''}</span>}
                  </div>
                  <p className="text-sm mt-1 text-slate-700 dark:text-slate-300">{f.finding}</p>
                  {f.recommendation && (
                    <p className="text-xs mt-1 italic text-slate-500 dark:text-slate-400">→ {f.recommendation}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {audit.missing_items.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
              <div className="text-xs font-semibold uppercase text-slate-500 mb-2">Missing categories detected by diff</div>
              <ul className="text-sm text-slate-700 dark:text-slate-300 space-y-1">
                {audit.missing_items.map((m, i) => (
                  <li key={i}>• [{m.category}] {m.description}</li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}

      {/* Line items */}
      <details className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900 dark:text-white">
          Line items ({lines.length})
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="text-left py-2 pr-2">#</th>
                <th className="text-left py-2 pr-2">Item</th>
                <th className="text-right py-2 pr-2">Qty</th>
                <th className="text-right py-2 pr-2">Wt (lbs)</th>
                <th className="text-right py-2 pr-2">IW hrs</th>
                <th className="text-left py-2 pr-2">Finish</th>
                <th className="text-right py-2 pr-2">Line $</th>
                <th className="text-right py-2 pr-2">Conf</th>
              </tr>
            </thead>
            <tbody className="text-slate-700 dark:text-slate-300">
              {lines.map((l) => (
                <tr key={l.line_no} className={`border-b border-slate-100 dark:border-slate-800 ${l.flagged_for_review ? 'bg-amber-50 dark:bg-amber-900/10' : ''}`}>
                  <td className="py-2 pr-2 font-mono">{l.line_no}</td>
                  <td className="py-2 pr-2">
                    <div className="font-medium">{l.category}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-md">{l.description}</div>
                  </td>
                  <td className="py-2 pr-2 text-right whitespace-nowrap">{l.quantity} {l.quantity_unit}</td>
                  <td className="py-2 pr-2 text-right">{l.total_weight_lbs?.toFixed(0) ?? '—'}</td>
                  <td className="py-2 pr-2 text-right">{l.ironworker_hrs?.toFixed(0) ?? '—'}</td>
                  <td className="py-2 pr-2">{l.finish ?? '—'}</td>
                  <td className="py-2 pr-2 text-right font-mono">{fmt$(l.line_total_usd)}</td>
                  <td className="py-2 pr-2 text-right">
                    <span className={l.confidence < 0.5 ? 'text-red-600 dark:text-red-400' : l.confidence < 0.7 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}>
                      {Math.round(l.confidence * 100)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
