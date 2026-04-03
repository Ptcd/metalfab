"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Opportunity, OpportunityStatus } from "@/types/opportunity";
import { ScoreBadge } from "../components/ScoreBadge";
import { StatusBadge } from "../components/StatusBadge";
import { AddOpportunityModal } from "./AddOpportunityModal";

const statuses: (OpportunityStatus | "")[] = ["", "new", "reviewing", "bidding", "won", "lost", "passed"];

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

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`/dashboard?${params.toString()}`);
  }

  return (
    <>
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={filters.status ?? "new"}
          onChange={(e) => updateFilter("status", e.target.value)}
          className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
        >
          <option value="all">All Statuses</option>
          {statuses.filter(Boolean).map((s) => (
            <option key={s} value={s}>{s}</option>
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

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            <tr>
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
                <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                  No opportunities found
                </td>
              </tr>
            ) : (
              opportunities.map((opp) => (
                <tr
                  key={opp.id}
                  onClick={() => router.push(`/opportunity/${opp.id}`)}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-slate-900 dark:text-white max-w-xs truncate">
                    {opp.title}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-[200px] truncate">
                    {opp.agency ?? "—"}
                  </td>
                  <td className={`px-4 py-3 ${isUrgent(opp.response_deadline) ? "text-red-600 dark:text-red-400 font-semibold" : "text-slate-600 dark:text-slate-300"}`}>
                    {formatDate(opp.response_deadline)}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {formatDollars(opp.dollar_min, opp.dollar_max)}
                  </td>
                  <td className="px-4 py-3">
                    <ScoreBadge score={opp.score} greenThreshold={greenThreshold} yellowThreshold={yellowThreshold} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={opp.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">
                    {opp.source}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddOpportunityModal onClose={() => setShowAdd(false)} />}
    </>
  );
}
