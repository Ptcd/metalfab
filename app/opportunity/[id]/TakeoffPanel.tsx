"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { computeScenarios, RateCard, TakeoffLine as ScenarioInputLine } from "@/lib/takeoff/scenarios";
import { EditableLinesTable, EditableLine } from "./EditableLinesTable";

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

interface ProposalRow {
  id: string;
  proposal_number: string;
  bid_total_usd: number;
  storage_path: string;
  filename: string;
  generated_at: string;
  status: string;
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
  const [run, setRun] = useState<TakeoffRun | null>(null);
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [audit, setAudit] = useState<AuditRow | null>(null);
  const [rate, setRate] = useState<RateCard | null>(null);
  const [proposal, setProposal] = useState<ProposalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [selected, setSelected] = useState<'conservative' | 'expected' | 'aggressive'>('expected');

  useEffect(() => {
    let active = true;
    (async () => {
      const [tRes, pRes] = await Promise.all([
        fetch(`/api/opportunities/${opportunityId}/takeoff`),
        fetch(`/api/opportunities/${opportunityId}/proposal`),
      ]);
      const tBody = await tRes.json().catch(() => ({}));
      const pBody = await pRes.json().catch(() => ({}));
      if (!active) return;
      if (tBody.data) {
        setRun(tBody.data.run);
        setLines(tBody.data.lines);
        setAudit(tBody.data.audit);
        setRate(tBody.data.rate_card);
      }
      setProposal(pBody.data || null);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [opportunityId]);

  // Recompute scenarios from current lines + rate card whenever either changes
  const scenarios = useMemo(() => {
    if (!rate) return null;
    return computeScenarios(lines as unknown as ScenarioInputLine[], rate);
  }, [lines, rate]);

  if (loading) return <div className="text-sm text-slate-500 italic">Loading takeoff…</div>;
  if (!run || !scenarios) return null;

  const readOnly = run.status === 'approved' || run.status === 'submitted';

  async function approve() {
    if (!run || !scenarios) return;
    setApproving(true);
    const bid = scenarios[selected].bid_total_usd;
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
    setRun({ ...run, status: 'approved', bid_total_usd: bid });
  }

  async function reopenForEdit() {
    if (!run) return;
    setReopening(true);
    const res = await fetch(`/api/opportunities/${opportunityId}/takeoff/reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: run.id }),
    });
    setReopening(false);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert(`Reopen failed: ${e.error || res.status}`);
      return;
    }
    setRun({ ...run, status: 'draft' });
  }

  async function generate() {
    setGenerating(true);
    const res = await fetch(`/api/opportunities/${opportunityId}/proposal/generate`, { method: 'POST' });
    setGenerating(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`Generate failed: ${body.error || res.status}`);
      return;
    }
    setProposal(body.data);
  }

  function onLinesChange(nextLines: EditableLine[], nextRun: Record<string, unknown>) {
    setLines(nextLines);
    setRun({ ...run!, ...(nextRun as unknown as Partial<TakeoffRun>) } as TakeoffRun);
  }

  // Spec-listed missing categories from the audit get a one-click add
  function addMissingItem(category: string, description: string) {
    fetch(`/api/opportunities/${opportunityId}/takeoff/lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        run_id: run!.id,
        category,
        description,
        quantity: 1,
        quantity_unit: 'EA',
        confidence: 0.5,
        flagged_for_review: true,
        source_kind: 'audit',
        source_evidence: 'Added from audit missing-items list',
      }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { alert(`Add failed: ${body.error || r.status}`); return; }
        setLines(body.data.lines as EditableLine[]);
        setRun({ ...run!, ...(body.data.run as unknown as Partial<TakeoffRun>) } as TakeoffRun);
      })
      .catch((e) => alert(`Add failed: ${e.message}`));
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

      {/* Approve / proposal action */}
      {!readOnly && (
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
      {readOnly && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-green-700 dark:text-green-300">
            ✓ Takeoff {run.status}. Bid total: {fmt$(run.bid_total_usd)}.
          </span>
          {!proposal && (
            <button
              type="button"
              onClick={generate}
              disabled={generating}
              className="px-3 py-1 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
            >
              {generating ? 'Generating…' : 'Generate proposal PDF'}
            </button>
          )}
          {proposal && (
            <a
              href={`/api/documents/${proposal.storage_path}`}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1 text-sm rounded bg-slate-700 hover:bg-slate-800 text-white"
            >
              Download {proposal.proposal_number}
            </a>
          )}
          {proposal && (
            <button
              type="button"
              onClick={generate}
              disabled={generating}
              className="px-3 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100 text-slate-700 dark:text-slate-300 dark:border-slate-600 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {generating ? 'Regenerating…' : 'Regenerate'}
            </button>
          )}
          <button
            type="button"
            onClick={reopenForEdit}
            disabled={reopening}
            className="px-3 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100 text-slate-700 dark:text-slate-300 dark:border-slate-600 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {reopening ? 'Reopening…' : 'Reopen for edit'}
          </button>
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
              <ul className="text-sm text-slate-700 dark:text-slate-300 space-y-2">
                {audit.missing_items.map((m, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="flex-1">• [{m.category}] {m.description}</span>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => addMissingItem(m.category, m.description)}
                        className="text-xs px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        Add to takeoff
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}

      {/* Editable line items */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-white">
            Line items ({lines.length})
            {readOnly && <span className="ml-2 text-xs text-slate-500">read-only</span>}
          </h4>
        </div>
        <EditableLinesTable
          lines={lines}
          runId={run.id}
          opportunityId={opportunityId}
          readOnly={readOnly}
          onLinesChange={onLinesChange}
        />
      </div>
    </div>
  );
}
