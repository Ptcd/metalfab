"use client";

import { useState } from "react";

export interface SystemRun {
  id: string;
  run_type: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  opportunities_processed: number;
  docs_downloaded: number;
  docs_purged: number;
  errors_encountered: Array<{ step: string; message: string; at: string }> | null;
  steps_completed: Array<{ step: string; at: string }> | null;
  notes: string | null;
}

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function SystemRunsList({ runs }: { runs: SystemRun[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (runs.length === 0) {
    return <p className="text-sm text-slate-400">No runs recorded yet.</p>;
  }

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
      {runs.map((r) => {
        const duration = r.ended_at
          ? Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000)
          : null;
        const errors = Array.isArray(r.errors_encountered) ? r.errors_encountered : [];
        const steps = Array.isArray(r.steps_completed) ? r.steps_completed : [];
        const statusColor =
          r.status === "success"
            ? "text-emerald-600 dark:text-emerald-400"
            : r.status === "failed"
            ? "text-red-600 dark:text-red-400"
            : r.status === "partial"
            ? "text-amber-600 dark:text-amber-400"
            : "text-slate-500";
        const expandable = errors.length > 0 || steps.length > 0 || !!r.notes;
        const isOpen = openId === r.id;

        return (
          <div key={r.id}>
            <button
              type="button"
              onClick={() => expandable && setOpenId(isOpen ? null : r.id)}
              disabled={!expandable}
              className={`w-full px-4 py-3 flex items-center justify-between text-sm text-left ${
                expandable
                  ? "hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer"
                  : "cursor-default"
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-900 dark:text-white">
                  <span className={statusColor}>●</span> {r.run_type}
                  {r.notes && <span className="text-xs text-slate-500 dark:text-slate-400 ml-2">({r.notes.slice(0, 100)})</span>}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {timeAgo(r.started_at)}
                  {duration != null && ` · ${duration}s`}
                  {r.opportunities_processed > 0 && ` · ${r.opportunities_processed} opps`}
                  {r.docs_downloaded > 0 && ` · ${r.docs_downloaded} downloaded`}
                  {r.docs_purged > 0 && ` · ${r.docs_purged} purged`}
                  {errors.length > 0 && (
                    <span className="text-red-600 dark:text-red-400"> · {errors.length} error{errors.length === 1 ? "" : "s"}</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0 ml-4">
                <span className={`text-xs font-semibold ${statusColor}`}>{r.status}</span>
                {expandable && (
                  <span className="text-slate-400 text-xs">{isOpen ? "▲" : "▼"}</span>
                )}
              </div>
            </button>

            {isOpen && expandable && (
              <div className="px-4 pb-4 bg-slate-50 dark:bg-slate-900/40 text-xs space-y-3">
                {r.notes && (
                  <div>
                    <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Notes</p>
                    <p className="text-slate-600 dark:text-slate-400 whitespace-pre-wrap">{r.notes}</p>
                  </div>
                )}
                {errors.length > 0 && (
                  <div>
                    <p className="font-semibold text-red-700 dark:text-red-400 mb-1">Errors</p>
                    <ul className="space-y-1">
                      {errors.map((e, i) => (
                        <li key={i} className="text-red-700 dark:text-red-300 font-mono">
                          <span className="text-slate-500">[{e.step}]</span> {e.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {steps.length > 0 && (
                  <div>
                    <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Steps completed</p>
                    <ul className="space-y-0.5">
                      {steps.map((s, i) => (
                        <li key={i} className="text-slate-600 dark:text-slate-400 font-mono">
                          ✓ {s.step}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
