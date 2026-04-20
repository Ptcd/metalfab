"use client";

import { useState } from "react";
import Link from "next/link";
import { Opportunity, OpportunityStatus, BidDocument, QaReport } from "@/types/opportunity";
import { ScoreSignal } from "@/types/scoring";
import { ScoreBadge } from "../../components/ScoreBadge";
import { StatusBadge } from "../../components/StatusBadge";

const allStatuses: OpportunityStatus[] = [
  "new",
  "reviewing",
  "awaiting_qa",
  "qa_qualified",
  "qa_rejected",
  "bidding",
  "won",
  "lost",
  "passed",
];

interface Props {
  opportunity: Opportunity;
  greenThreshold: number;
  yellowThreshold: number;
}

export function OpportunityDetail({ opportunity, greenThreshold, yellowThreshold }: Props) {
  const [opp, setOpp] = useState(opportunity);
  const [notes, setNotes] = useState(opp.notes ?? "");
  const [status, setStatus] = useState<OpportunityStatus>(opp.status);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    setSaved(false);

    const res = await fetch(`/api/opportunities/${opp.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, notes }),
    });

    if (res.ok) {
      const { data } = await res.json();
      setOpp(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }

    setSaving(false);
  }

  const signals: ScoreSignal[] = Array.isArray(opp.score_signals) ? opp.score_signals : [];
  const documents: BidDocument[] = Array.isArray(opp.documents) ? opp.documents : [];
  const qaReport: QaReport | null = opp.qa_report ?? null;

  function formatDollars(n: number | null) {
    if (n == null) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  }

  function formatDate(d: string | null) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  return (
    <div className="max-w-4xl">
      <Link href="/dashboard" className="text-sm text-blue-600 dark:text-blue-400 hover:underline mb-4 inline-block">
        &larr; Back to Pipeline
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-1">{opp.title}</h2>
          <p className="text-slate-500 dark:text-slate-400">{opp.agency ?? "Unknown Agency"}</p>
        </div>
        <ScoreBadge score={opp.score} greenThreshold={greenThreshold} yellowThreshold={yellowThreshold} />
      </div>

      {/* Key info grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <InfoCard label="Dollar Range" value={`${formatDollars(opp.dollar_min)} – ${formatDollars(opp.dollar_max)}`} />
        <InfoCard label="Deadline" value={formatDate(opp.response_deadline)} />
        <InfoCard label="NAICS" value={opp.naics_code ?? "—"} />
        <InfoCard label="Source" value={opp.source} />
      </div>

      {/* Description */}
      {opp.description && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Description</h3>
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-60 overflow-y-auto">
            {opp.description}
          </div>
        </div>
      )}

      {/* Contact */}
      {(opp.point_of_contact || opp.contact_email) && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Point of Contact</h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {opp.point_of_contact}{opp.contact_email ? ` — ${opp.contact_email}` : ""}
          </p>
        </div>
      )}

      {/* QA Report */}
      {qaReport && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
            QA Report
            {opp.qa_needs_human_review && (
              <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">(needs human review)</span>
            )}
          </h3>
          <div className="bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-900/40 rounded-lg p-4 space-y-3 text-sm">
            <div>
              <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Recommendation</span>
              <p className="font-semibold text-slate-900 dark:text-white">
                {qaReport.recommendation}
                {qaReport.steel_metals_estimated_value_usd != null &&
                  ` · Metals est. ~$${qaReport.steel_metals_estimated_value_usd.toLocaleString()}`}
              </p>
              {qaReport.recommendation_reasoning && (
                <p className="text-slate-700 dark:text-slate-300 italic mt-1">{qaReport.recommendation_reasoning}</p>
              )}
            </div>
            {qaReport.scope_summary && (
              <div>
                <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Scope summary</span>
                <p className="text-slate-800 dark:text-slate-200 whitespace-pre-wrap">{qaReport.scope_summary}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Steel/metals present</span>
                <p className="text-slate-900 dark:text-white">{qaReport.steel_metals_present ? "yes" : "no"}</p>
              </div>
              <div>
                <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Due date (confirmed)</span>
                <p className="text-slate-900 dark:text-white">{qaReport.due_date_confirmed ?? "—"}</p>
              </div>
              <div>
                <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Pre-bid meeting</span>
                <p className="text-slate-900 dark:text-white">{qaReport.pre_bid_meeting ?? "—"}</p>
              </div>
              <div>
                <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Location</span>
                <p className="text-slate-900 dark:text-white">{qaReport.location_address ?? "—"}</p>
              </div>
            </div>
            {(qaReport.risk_flags?.length ?? 0) > 0 && (
              <div>
                <span className="text-xs uppercase tracking-wider text-amber-700 dark:text-amber-400">Risk flags</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {qaReport.risk_flags.map((f) => (
                    <span key={f} className="text-xs font-mono bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-2 py-0.5 rounded">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(qaReport.scope_exclusions?.length ?? 0) > 0 && (
              <div>
                <span className="text-xs uppercase tracking-wider text-amber-700 dark:text-amber-400">Scope exclusions</span>
                <ul className="list-disc list-inside text-slate-800 dark:text-slate-200 mt-1">
                  {qaReport.scope_exclusions.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-500">Analyzed {qaReport.analyzed_at}</p>
          </div>
        </div>
      )}

      {/* Documents */}
      {documents.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
            Documents ({documents.length})
          </h3>
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
            {documents.map((d) => (
              <div key={d.storage_path} className="px-4 py-2 text-sm flex items-center justify-between">
                <div>
                  <p className="text-slate-900 dark:text-white">{d.filename}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {d.category} · {Math.round(d.file_size / 1024)} KB · {d.mime_type}
                  </p>
                </div>
                <span className="text-xs text-slate-400 font-mono">{d.storage_path}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {opp.docs_purged_at && documents.length === 0 && (
        <p className="text-xs text-slate-400 italic mb-6">
          Documents purged at {new Date(opp.docs_purged_at).toLocaleString()}.
        </p>
      )}

      {/* Score breakdown */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Score Breakdown</h3>
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
          {signals.map((s, i) => (
            <div key={i} className={`flex items-center justify-between px-4 py-2 text-sm ${s.fired ? "" : "opacity-40"}`}>
              <span className="text-slate-700 dark:text-slate-300">{s.signal}</span>
              <span className={`font-mono font-semibold ${s.delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                {s.fired ? (s.delta > 0 ? `+${s.delta}` : s.delta) : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Status + Notes */}
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 mb-6">
        <div className="flex items-center gap-4 mb-4">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as OpportunityStatus)}
            className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
          >
            {allStatuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <StatusBadge status={status} />
        </div>

        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white mb-3"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>}
        </div>
      </div>

      {/* Link to original */}
      {opp.source_url && (
        <a
          href={opp.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          View Original Posting &rarr;
        </a>
      )}
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">{label}</p>
      <p className="text-sm font-medium text-slate-900 dark:text-white">{value}</p>
    </div>
  );
}
