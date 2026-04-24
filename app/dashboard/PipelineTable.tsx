"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Opportunity, OpportunityStatus, STATUS_LABELS } from "@/types/opportunity";
import { ScoreBadge } from "../components/ScoreBadge";
import { StatusBadge } from "../components/StatusBadge";
import { AddOpportunityModal } from "./AddOpportunityModal";

const statuses: (OpportunityStatus | "")[] = [
  "",
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

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDollars(min: number | null, max: number | null): string {
  const fmt = (n: number) => {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
    return `$${n}`;
  };
  if (min != null && max != null && min !== max) return `${fmt(min)}–${fmt(max)}`;
  if (max != null) return fmt(max);
  if (min != null) return fmt(min);
  return "—";
}

function isUrgent(deadline: string | null): boolean {
  if (!deadline) return false;
  const diff = new Date(deadline).getTime() - Date.now();
  return diff > 0 && diff < 72 * 60 * 60 * 1000;
}

interface Props {
  opportunities: Opportunity[];
  count: number;
  greenThreshold: number;
  yellowThreshold: number;
  filters: { status?: string; score_min?: string; score_max?: string; search?: string };
}

export function PipelineTable({ opportunities, count, greenThreshold, yellowThreshold, filters }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showAdd, setShowAdd] = useState(false);
  const [dropFiles, setDropFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const allSelected = opportunities.length > 0 && selected.size === opportunities.length;
  const anySelected = selected.size > 0;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(opportunities.map((o) => o.id)));
  }

  async function bulkStatus(target: OpportunityStatus) {
    if (!anySelected || bulkBusy) return;
    const note = target === "passed" ? "Bulk-passed on dashboard" : undefined;
    const count = selected.size;
    const purgeWarning = (target === "passed" || target === "qa_rejected" || target === "lost")
      ? "\n\nDocuments on these opportunities will be purged."
      : "";
    if (!confirm(`Set ${count} opportunity/ies to "${STATUS_LABELS[target]}"?${purgeWarning}`)) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const res = await fetch("/api/opportunities/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: Array.from(selected),
          status: target,
          note,
        }),
      });
      const body = await res.json();
      if (res.ok) {
        setBulkResult(`✓ ${body.updated} updated${body.purged_docs ? `, ${body.purged_docs} docs purged` : ""}`);
        setSelected(new Set());
        router.refresh();
      } else {
        setBulkResult(`✗ ${body.error || res.status}`);
      }
    } finally {
      setBulkBusy(false);
      setTimeout(() => setBulkResult(null), 4000);
    }
  }

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`/dashboard?${params.toString()}`);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    // Guess title from the first file's name (strip extension, replace _ with spaces)
    const firstName = files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    setDropFiles(files);
    setShowAdd(true);
    // Stash the guessed title in a module-level var via ref? — the modal reads it via prop
    (window as unknown as { __dropInitial?: { title: string; droppedFiles: File[] } }).__dropInitial = {
      title: firstName,
      droppedFiles: files,
    };
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      className="relative"
    >
      {isDragOver && (
        <div className="fixed inset-0 z-40 pointer-events-none bg-blue-500/10 border-4 border-dashed border-blue-500 flex items-center justify-center">
          <p className="text-lg font-semibold text-blue-700 dark:text-blue-300 bg-white dark:bg-slate-800 px-6 py-3 rounded-lg shadow">
            Drop files to create a new opportunity with attachments
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={filters.status ?? "reviewing"}
          onChange={(e) => updateFilter("status", e.target.value)}
          className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
        >
          <option value="all">All Statuses</option>
          {statuses.filter(Boolean).map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s as OpportunityStatus]}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Search title or agency..."
          defaultValue={filters.search ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") updateFilter("search", (e.target as HTMLInputElement).value);
          }}
          className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 w-64"
        />

        <span className="text-sm text-slate-500 dark:text-slate-400 ml-auto">
          {count} opportunities
        </span>

        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + Add Opportunity
        </button>
      </div>

      {/* Bulk action bar — appears when anything is checked */}
      {anySelected && (
        <div className="mb-3 flex items-center gap-3 rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-900/50 px-4 py-2">
          <span className="text-sm font-medium text-blue-900 dark:text-blue-200">
            {selected.size} selected
          </span>
          <button
            onClick={() => bulkStatus("passed")}
            disabled={bulkBusy}
            className="px-3 py-1 rounded text-xs font-medium bg-slate-600 hover:bg-slate-700 text-white disabled:opacity-50"
            title="Mark as passed + purge any docs"
          >
            Mark Passed
          </button>
          <button
            onClick={() => bulkStatus("reviewing")}
            disabled={bulkBusy}
            className="px-3 py-1 rounded text-xs font-medium bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50"
          >
            Move to Under Review
          </button>
          <button
            onClick={() => bulkStatus("awaiting_qa")}
            disabled={bulkBusy}
            className="px-3 py-1 rounded text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50"
          >
            Queue for AI
          </button>
          <button
            onClick={() => setSelected(new Set())}
            disabled={bulkBusy}
            className="ml-auto text-xs text-slate-600 dark:text-slate-300 hover:underline"
          >
            Clear selection
          </button>
          {bulkResult && <span className="text-xs text-emerald-700 dark:text-emerald-300 ml-2">{bulkResult}</span>}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            <tr>
              <th className="px-3 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  title={allSelected ? "Unselect all" : "Select all visible"}
                  className="rounded"
                />
              </th>
              <th className="text-left px-4 py-3 font-medium">Title</th>
              <th className="text-left px-4 py-3 font-medium">Agency</th>
              <th className="text-left px-4 py-3 font-medium">Due Date</th>
              <th className="text-left px-4 py-3 font-medium">$ Range</th>
              <th className="text-left px-4 py-3 font-medium">Score</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
            {opportunities.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                  No opportunities found
                </td>
              </tr>
            ) : (
              opportunities.map((opp) => {
                const isSelected = selected.has(opp.id);
                return (
                  <tr
                    key={opp.id}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${
                      isSelected ? "bg-blue-50 dark:bg-blue-900/20" : ""
                    }`}
                  >
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(opp.id)}
                        className="rounded"
                      />
                    </td>
                    <td
                      className="px-4 py-3 font-medium text-slate-900 dark:text-white max-w-xs truncate cursor-pointer"
                      onClick={() => router.push(`/opportunity/${opp.id}`)}
                    >
                      {opp.title}
                    </td>
                    <td
                      className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-[200px] truncate cursor-pointer"
                      onClick={() => router.push(`/opportunity/${opp.id}`)}
                    >
                      {opp.agency ?? "—"}
                    </td>
                    <td
                      className={`px-4 py-3 cursor-pointer ${isUrgent(opp.response_deadline) ? "text-red-600 dark:text-red-400 font-semibold" : "text-slate-600 dark:text-slate-300"}`}
                      onClick={() => router.push(`/opportunity/${opp.id}`)}
                    >
                      {formatDate(opp.response_deadline)}
                    </td>
                    <td
                      className="px-4 py-3 text-slate-600 dark:text-slate-300 cursor-pointer"
                      onClick={() => router.push(`/opportunity/${opp.id}`)}
                    >
                      {formatDollars(opp.dollar_min, opp.dollar_max)}
                    </td>
                    <td className="px-4 py-3 cursor-pointer" onClick={() => router.push(`/opportunity/${opp.id}`)}>
                      <ScoreBadge score={opp.score} greenThreshold={greenThreshold} yellowThreshold={yellowThreshold} />
                    </td>
                    <td className="px-4 py-3 cursor-pointer" onClick={() => router.push(`/opportunity/${opp.id}`)}>
                      <StatusBadge status={opp.status} />
                    </td>
                    <td
                      className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs cursor-pointer"
                      onClick={() => router.push(`/opportunity/${opp.id}`)}
                    >
                      {opp.source}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddOpportunityModal
          onClose={() => {
            setShowAdd(false);
            setDropFiles([]);
            delete (window as unknown as { __dropInitial?: unknown }).__dropInitial;
          }}
          initial={
            dropFiles.length > 0
              ? (window as unknown as { __dropInitial?: { title: string; droppedFiles: File[] } }).__dropInitial
              : undefined
          }
        />
      )}
    </div>
  );
}
