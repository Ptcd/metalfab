"use client";

import { useState } from "react";
import Link from "next/link";
import { REMINDER_TYPE_LABELS, ReminderType } from "@/types/opportunity";

export interface ReminderRow {
  id: string;
  opportunity_id: string | null;
  customer_id: string | null;
  reminder_type: ReminderType;
  due_at: string;
  subject: string;
  body: string | null;
  opportunity_title?: string | null;
  customer_name?: string | null;
}

function daysUntil(iso: string): number {
  const diff = new Date(iso).getTime() - Date.now();
  return Math.ceil(diff / 86400000);
}

function dueClass(days: number) {
  if (days < 0) return "text-red-700 dark:text-red-300 font-bold";
  if (days === 0) return "text-orange-700 dark:text-orange-300 font-semibold";
  if (days <= 2) return "text-amber-700 dark:text-amber-300";
  return "text-slate-600 dark:text-slate-400";
}

export function RemindersList({ reminders: initial }: { reminders: ReminderRow[] }) {
  const [reminders, setReminders] = useState(initial);

  async function complete(id: string) {
    setReminders((prev) => prev.filter((r) => r.id !== id));
    await fetch(`/api/reminders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complete: true }),
    });
  }

  async function snooze(id: string, days: number) {
    setReminders((prev) => prev.filter((r) => r.id !== id));
    await fetch(`/api/reminders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snooze_days: days }),
    });
  }

  if (reminders.length === 0) return null;

  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wider mb-3">
        Reminders ({reminders.length})
      </h3>
      <div className="bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-900/40 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
        {reminders.map((r) => {
          const days = daysUntil(r.due_at);
          const label =
            days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`
            : days === 0 ? "Due today"
            : `Due in ${days} day${days === 1 ? "" : "s"}`;
          const href = r.opportunity_id
            ? `/opportunity/${r.opportunity_id}`
            : r.customer_id
            ? `/customers/${r.customer_id}`
            : "#";
          return (
            <div key={r.id} className="px-4 py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-xs font-mono ${dueClass(days)}`}>{label}</span>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">
                    {REMINDER_TYPE_LABELS[r.reminder_type]}
                  </span>
                </div>
                <Link href={href} className="text-sm font-medium text-slate-900 dark:text-white hover:underline">
                  {r.subject}
                </Link>
                {r.body && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">{r.body}</p>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <button
                  onClick={() => complete(r.id)}
                  className="text-xs px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white"
                  title="Mark complete"
                >
                  ✓ Done
                </button>
                <button
                  onClick={() => snooze(r.id, 1)}
                  className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700"
                  title="Snooze 1 day"
                >
                  +1d
                </button>
                <button
                  onClick={() => snooze(r.id, 7)}
                  className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700"
                  title="Snooze 7 days"
                >
                  +7d
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
