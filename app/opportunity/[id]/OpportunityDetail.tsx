"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Opportunity, OpportunityStatus, BidDocument, QaReport, Customer,
  DocumentCategory, DOCUMENT_CATEGORY_LABELS,
  INBOUND_CATEGORIES, INTERNAL_CATEGORIES, STATUS_LABELS,
} from "@/types/opportunity";
import { ScoreSignal } from "@/types/scoring";
import { ScoreBadge } from "../../components/ScoreBadge";
import { StatusBadge } from "../../components/StatusBadge";
import { BidSubmitButton } from "./BidSubmitButton";
import { RunTakeoffQaButton } from "./RunTakeoffQaButton";
import { SendEmailButton } from "../../components/SendEmailButton";

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

  const [referrer, setReferrer] = useState(opp.referrer ?? "");
  const [estimatedValue, setEstimatedValue] = useState<string>(
    opp.estimated_value != null ? String(opp.estimated_value) : ""
  );
  const [confidence, setConfidence] = useState(opp.confidence ?? "");
  const [uploading, setUploading] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<DocumentCategory>("shop_drawing");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Customer picker state
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [searchedCustomers, setSearchedCustomers] = useState(false);

  // Load the current customer if linked
  useEffect(() => {
    if (!opp.customer_id || customer?.id === opp.customer_id) return;
    fetch(`/api/customers/${opp.customer_id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (b?.data) setCustomer(b.data); })
      .catch(() => {});
  }, [opp.customer_id, customer?.id]);

  // Customer search
  useEffect(() => {
    if (!customerQuery.trim()) { setCustomerResults([]); setSearchedCustomers(false); return; }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(customerQuery)}`);
      if (res.ok) {
        const { data } = await res.json();
        setCustomerResults(data || []);
        setSearchedCustomers(true);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [customerQuery]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);

    const res = await fetch(`/api/opportunities/${opp.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status, notes,
        referrer: referrer || null,
        estimated_value: estimatedValue ? Number(estimatedValue) : null,
        confidence: confidence || null,
        customer_id: customer?.id ?? null,
      }),
    });

    if (res.ok) {
      const { data } = await res.json();
      setOpp(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 3500);
    }

    setSaving(false);
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("category", uploadCategory);
        const res = await fetch(`/api/opportunities/${opp.id}/documents`, {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          alert(`Upload failed (${f.name}): ${body.error || res.status}`);
          continue;
        }
        const { data: newDoc } = await res.json();
        setOpp((prev) => ({ ...prev, documents: [...(prev.documents || []), newDoc] }));
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDeleteDoc(d: BidDocument) {
    const isInbound = (INBOUND_CATEGORIES as string[]).includes(d.category);
    // Heavier confirm for inbound (from the GC / agency) — those may not be
    // easy to re-download if we nuke them, especially SAM.gov controlled
    // access attachments. Internal TCB artifacts can be re-uploaded anytime.
    const message = isInbound
      ? `⚠️  Delete INBOUND bid document: ${d.filename}?\n\nThis came from the GC / agency and may not be re-downloadable if SAM.gov or the source portal has moved on. Are you sure?`
      : `Delete ${d.filename}?`;
    if (!confirm(message)) return;
    const res = await fetch(
      `/api/opportunities/${opp.id}/documents/${encodeURIComponent(d.filename)}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      setOpp((prev) => ({
        ...prev,
        documents: (prev.documents || []).filter((x) => x.storage_path !== d.storage_path),
      }));
    }
  }

  const signals: ScoreSignal[] = Array.isArray(opp.score_signals) ? opp.score_signals : [];
  const documents: BidDocument[] = Array.isArray(opp.documents) ? opp.documents : [];
  const qaReport: QaReport | null = opp.qa_report ?? null;

  // Group documents by inbound vs internal for cleaner display
  const inboundDocs = documents.filter((d) =>
    (INBOUND_CATEGORIES as string[]).includes(d.category)
  );
  const internalDocs = documents.filter((d) =>
    (INTERNAL_CATEGORIES as string[]).includes(d.category)
  );

  function formatDollars(n: number | null) {
    if (n == null) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  }

  function formatDollarRange(min: number | null, max: number | null) {
    if (min == null && max == null) return "Not specified";
    if (min != null && max == null) return `from ${formatDollars(min)}`;
    if (min == null && max != null) return `up to ${formatDollars(max)}`;
    if (min === max) return formatDollars(min);
    return `${formatDollars(min)} – ${formatDollars(max)}`;
  }

  function formatDate(d: string | null) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  function formatDateTime(d: string | null) {
    if (!d) return "—";
    const dt = new Date(d);
    return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
      + " at "
      + dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  }

  // Scraped descriptions from SAM.gov / BidNet come through as one wall of
  // text with embedded HTML. Strip the markup, then insert line breaks
  // before a fixed whitelist of known section labels. We avoid open-ended
  // ALL-CAPS matching because it false-positives on acronyms (UEI, SAM,
  // NAICS) and on labels that include punctuation (SOLICITATION / NOTICE).
  function prettifyDescription(raw: string | null | undefined): string {
    if (!raw) return "";

    // Known labels — all must start on their own line. Most common first.
    // Use alternation grouped by length (longest first, so "SOLICITATION
    // NUMBER" wins over "SOLICITATION"). Each label ends in a colon.
    const LABELS = [
      "SOLICITATION NOTICE",
      "SOLICITATION NUMBER",
      "SOLICITATION / NOTICE",
      "SOLICITATION",
      "PROJECT MAGNITUDE",
      "PROJECT TITLE",
      "PROJECT NUMBER",
      "PROJECT DESCRIPTION",
      "TYPE OF CONTRACT",
      "TYPE OF AWARD",
      "NAICS CODE CLASSIFICATION and SET ASIDE",
      "NAICS CODE",
      "NAICS",
      "EVALUATION FACTORS",
      "EVALUATION CRITERIA",
      "SET ASIDE",
      "SITE VISIT",
      "PRE-BID MEETING",
      "PRE BID MEETING",
      "POINT OF CONTACT",
      "POINTS OF CONTACT",
      "POC",
      "REGISTRATIONS",
      "BID DUE DATE",
      "RESPONSE DEADLINE",
      "QUESTIONS DUE",
      "QUESTIONS DEADLINE",
      "DESCRIPTION OF WORK",
      "STATEMENT OF WORK",
      "SCOPE OF WORK",
      "SCOPE",
      "PERIOD OF PERFORMANCE",
      "PLACE OF PERFORMANCE",
      "DELIVERY",
      "SHIPPING",
      "WAGE DETERMINATION",
      "CONSTRUCTION MAGNITUDE",
      "PRODUCT SERVICE CODE",
      "SMALL BUSINESS SIZE STANDARD",
      "IMPORTANT DATES",
      "IMPORTANT DATES & DEADLINES",
      "NOTICE TO ALL OFFERORS",
      "NOTICE TO CONTRACTORS",
    ];
    // Amendment labels, numbered. Matched separately.
    const amendmentRe = /\bAMENDMENT\s*(?:NO\.?\s*)?\d+:/g;

    // Escape regex metacharacters in label strings and join alternation
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Longer first so regex engine chooses specific over generic
    const sortedLabels = LABELS.slice().sort((a, b) => b.length - a.length);
    const labelPattern = new RegExp(
      `([^\\n])\\s*(${sortedLabels.map(escape).join("|")}):`,
      "g"
    );

    const out = raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Labels: if one appears mid-line, break before it
      .replace(labelPattern, "$1\n\n$2:")
      .replace(amendmentRe, "\n\n$&")
      // Value run-on: "NUMBER: 140P6426B0002PROJECT MAGNITUDE:" has no
      // space between the value and the next label. After the above pass
      // the label ended up split by the regex only if the preceding char
      // is non-word — which it isn't here ("2P"). Split alphanumeric→UPPER
      // transition when followed by a whitelisted label.
      .replace(
        new RegExp(
          `([a-z0-9])(${sortedLabels.map(escape).join("|")}):`,
          "g"
        ),
        "$1\n\n$2:"
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return out;
  }

  return (
    <div className="max-w-4xl">
      {/* Floating save toast */}
      {saved && (
        <div className="fixed top-4 right-4 z-50 bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-md shadow-lg animate-in fade-in slide-in-from-top-2">
          ✓ Saved
        </div>
      )}

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
        <InfoCard label="Dollar Range" value={formatDollarRange(opp.dollar_min, opp.dollar_max)} />
        <InfoCard label="Deadline" value={formatDate(opp.response_deadline)} />
        <InfoCard label="NAICS" value={opp.naics_code ?? "—"} />
        <InfoCard label="Source" value={opp.source} />
      </div>

      {/* Description */}
      {opp.description && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Description</h3>
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-80 overflow-y-auto leading-relaxed">
            {prettifyDescription(opp.description)}
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
                <p className="text-slate-900 dark:text-white">{formatDateTime(qaReport.pre_bid_meeting)}</p>
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

            {/* v2 fields: finish + connection notes + identified members */}
            {(qaReport.finish_spec || qaReport.connection_notes) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-emerald-200 dark:border-emerald-900/40">
                {qaReport.finish_spec && (
                  <div>
                    <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Finish</span>
                    <p className="text-slate-800 dark:text-slate-200 text-sm">{qaReport.finish_spec}</p>
                  </div>
                )}
                {qaReport.connection_notes && (
                  <div>
                    <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Connections</span>
                    <p className="text-slate-800 dark:text-slate-200 text-sm">{qaReport.connection_notes}</p>
                  </div>
                )}
              </div>
            )}

            {(qaReport.identified_members?.length ?? 0) > 0 && (
              <div className="pt-2 border-t border-emerald-200 dark:border-emerald-900/40">
                <span className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                  Identified members ({qaReport.identified_members!.length})
                </span>
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="text-left py-1 pr-3">Kind</th>
                        <th className="text-left py-1 pr-3">Mark</th>
                        <th className="text-left py-1 pr-3">Size</th>
                        <th className="text-right py-1 pr-3">Qty</th>
                        <th className="text-left py-1 pr-3">Unit</th>
                        <th className="text-left py-1">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-emerald-100 dark:divide-emerald-900/30">
                      {qaReport.identified_members!.map((m, i) => (
                        <tr key={i} className="text-slate-800 dark:text-slate-200">
                          <td className="py-1 pr-3 font-medium">{m.kind}</td>
                          <td className="py-1 pr-3 font-mono">{m.mark || "—"}</td>
                          <td className="py-1 pr-3">{m.size || "—"}</td>
                          <td className="py-1 pr-3 text-right">{m.quantity ?? "—"}</td>
                          <td className="py-1 pr-3">{m.unit || "—"}</td>
                          <td className="py-1 text-slate-600 dark:text-slate-400">{m.notes || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(qaReport.ai_caveats?.length ?? 0) > 0 && (
              <div className="pt-2 border-t border-emerald-200 dark:border-emerald-900/40">
                <span className="text-xs uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  AI caveats
                </span>
                <ul className="list-disc list-inside text-slate-700 dark:text-slate-300 text-xs mt-1">
                  {qaReport.ai_caveats!.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}

            <p className="text-xs text-slate-500 dark:text-slate-500">Analyzed {qaReport.analyzed_at}</p>
          </div>
        </div>
      )}

      {/* Documents */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            Documents ({documents.length})
          </h3>
          <div className="flex items-center gap-2">
            <select
              value={uploadCategory}
              onChange={(e) => setUploadCategory(e.target.value as DocumentCategory)}
              className="text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-2 py-1"
            >
              <optgroup label="Internal artifacts">
                {INTERNAL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{DOCUMENT_CATEGORY_LABELS[c]}</option>
                ))}
              </optgroup>
              <optgroup label="Inbound bid docs">
                {INBOUND_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{DOCUMENT_CATEGORY_LABELS[c]}</option>
                ))}
              </optgroup>
            </select>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => handleUpload(e.target.files)}
              className="hidden"
              id="doc-upload-input"
            />
            <label
              htmlFor="doc-upload-input"
              className="text-xs cursor-pointer px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              {uploading ? "Uploading…" : "+ Upload"}
            </label>
          </div>
        </div>

        {internalDocs.length > 0 && (
          <div className="mb-3">
            <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Internal (shop drawings, proposals, takeoffs…)</p>
            <DocList docs={internalDocs} onDelete={handleDeleteDoc} />
          </div>
        )}
        {inboundDocs.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Inbound (from GC / agency)</p>
            <DocList docs={inboundDocs} onDelete={handleDeleteDoc} />
          </div>
        )}
        {documents.length === 0 && (
          <p className="text-xs text-slate-400 italic">
            No documents yet.
            {opp.docs_purged_at && ` (Purged ${new Date(opp.docs_purged_at).toLocaleString()}.)`}
          </p>
        )}
      </div>

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

      {/* Status + editable CRM fields */}
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 mb-6 space-y-4">
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as OpportunityStatus)}
            className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
          >
            {allStatuses.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          <StatusBadge status={status} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">TCB Est. $</label>
            <input
              type="number"
              value={estimatedValue}
              onChange={(e) => setEstimatedValue(e.target.value)}
              placeholder="—"
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
            />
            {estimatedValue && !isNaN(Number(estimatedValue)) && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(estimatedValue))}
                {(Number(estimatedValue) < 10000 || Number(estimatedValue) > 1500000) && (
                  <span className="ml-1 text-amber-600 dark:text-amber-400">· outside $10k–$1.5M range</span>
                )}
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Confidence</label>
            <select
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
            >
              <option value="">—</option>
              <option value="hot">Hot (very likely)</option>
              <option value="warm">Warm (worth a look)</option>
              <option value="cold">Cold (long shot)</option>
            </select>
          </div>
        </div>

        {/* Customer / GC picker */}
        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Customer / GC</label>
          {customer ? (
            <div className="flex items-center gap-2 rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/20 px-3 py-2">
              <Link href={`/customers/${customer.id}`} className="flex-1 min-w-0 hover:underline">
                <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{customer.name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {customer.company || customer.email || "—"}
                </p>
              </Link>
              <button
                type="button"
                onClick={() => setCustomer(null)}
                className="text-xs text-red-600 hover:underline shrink-0"
              >
                Unlink
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="Search existing customers…"
                className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
              />
              {customerQuery && (
                <div className="absolute z-10 left-0 right-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg max-h-48 overflow-y-auto">
                  {customerResults.length === 0 && searchedCustomers ? (
                    <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                      No matches —{" "}
                      <a
                        href="/customers?new=1"
                        target="_blank"
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        create customer →
                      </a>
                    </div>
                  ) : (
                    customerResults.map((c) => (
                      <button
                        type="button"
                        key={c.id}
                        onClick={() => {
                          setCustomer(c);
                          setCustomerQuery("");
                          setCustomerResults([]);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-sm"
                      >
                        <span className="font-medium text-slate-900 dark:text-white">{c.name}</span>
                        {c.company && <span className="text-slate-500 dark:text-slate-400"> · {c.company}</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Referrer (free text — names, emails, context)</label>
          <textarea
            value={referrer}
            onChange={(e) => setReferrer(e.target.value)}
            rows={2}
            placeholder="e.g. Mike at CD Smith (mike@cdsmith.com) — referred us for the Ripon job"
            className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
          <BidSubmitButton oppId={opp.id} gcEmail={opp.contact_email} />
          <SendEmailButton
            toEmail={opp.contact_email || customer?.email}
            customerId={customer?.id ?? null}
            opportunityId={opp.id}
            buttonLabel="Email GC"
          />
          <RunTakeoffQaButton
            oppId={opp.id}
            hasTakeoff={documents.some((d) => d.category === "takeoff")}
            hasQaReport={!!qaReport}
          />
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>}
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-slate-200 dark:border-slate-700">
          <span>Added via {opp.added_via || 'scraper'}</span>
          {opp.added_by && <span> · by {opp.added_by}</span>}
          <span> · channel: {opp.source_channel || 'scraper'}</span>
        </p>
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

function DocList({
  docs,
  onDelete,
}: {
  docs: BidDocument[];
  onDelete: (d: BidDocument) => void;
}) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
      {docs.map((d) => {
        const viewUrl = `/api/documents/${d.storage_path}`;
        const downloadUrl = `${viewUrl}?download=1`;
        return (
          <div key={d.storage_path} className="px-4 py-2 text-sm flex items-center justify-between gap-3">
            <a
              href={viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 min-w-0 group"
            >
              <p className="text-blue-600 dark:text-blue-400 group-hover:underline truncate">{d.filename}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {DOCUMENT_CATEGORY_LABELS[d.category] || d.category}
                {' · '}{Math.round(d.file_size / 1024)} KB
                {d.uploaded_by && <span> · by {d.uploaded_by}</span>}
              </p>
            </a>
            <a
              href={downloadUrl}
              className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 shrink-0"
              title="Download"
            >
              ↓
            </a>
            <button
              onClick={() => onDelete(d)}
              className="text-xs text-slate-400 hover:text-red-600 shrink-0"
              title="Delete"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
