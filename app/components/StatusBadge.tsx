import { OpportunityStatus, STATUS_LABELS } from "@/types/opportunity";

const statusStyles: Record<OpportunityStatus, string> = {
  new: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  reviewing: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  awaiting_qa: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  qa_qualified: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  qa_rejected: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  bidding: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  won: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  lost: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  passed: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
};

export function StatusBadge({ status }: { status: OpportunityStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${statusStyles[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
