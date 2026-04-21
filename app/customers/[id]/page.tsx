import { createServiceClient } from "@/lib/db/supabase";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Customer } from "@/types/opportunity";
import { StatusBadge } from "../../components/StatusBadge";
import { OpportunityStatus } from "@/types/opportunity";

export const dynamic = "force-dynamic";

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDollars(n: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

export default async function CustomerDetailPage({ params }: { params: { id: string } }) {
  const supabase = createServiceClient();

  const [{ data: customer }, { data: opps }] = await Promise.all([
    supabase.from("customers").select("*").eq("id", params.id).single(),
    supabase.from("opportunities")
      .select("id, title, status, score, response_deadline, estimated_value, updated_at, agency")
      .eq("customer_id", params.id)
      .order("updated_at", { ascending: false }),
  ]);

  if (!customer) notFound();
  const c = customer as Customer;
  const opportunities = opps || [];

  const wonValue = opportunities
    .filter((o) => o.status === 'won')
    .reduce((sum, o) => sum + (o.estimated_value || 0), 0);

  return (
    <div className="max-w-4xl">
      <Link href="/customers" className="text-sm text-blue-600 dark:text-blue-400 hover:underline mb-4 inline-block">
        ← All customers
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{c.name}</h2>
          <p className="text-slate-500 dark:text-slate-400">
            {c.company && <span>{c.company}</span>}
            {c.role && <span className="ml-2 text-xs font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700">{c.role}</span>}
          </p>
        </div>
      </div>

      {/* Contact */}
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 mb-6 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">Email</p>
          <p className="text-slate-900 dark:text-white">
            {c.email ? <a href={`mailto:${c.email}`} className="text-blue-600 hover:underline">{c.email}</a> : "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">Phone</p>
          <p className="text-slate-900 dark:text-white">
            {c.phone ? <a href={`tel:${c.phone}`} className="text-blue-600 hover:underline">{c.phone}</a> : "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">First seen</p>
          <p className="text-slate-900 dark:text-white">{fmtDate(c.first_seen)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">Last contact</p>
          <p className="text-slate-900 dark:text-white">{fmtDate(c.last_contact)}</p>
        </div>
      </div>

      {c.notes && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-lg p-4 mb-6">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 uppercase tracking-wider mb-1">Notes</p>
          <p className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap">{c.notes}</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <Stat label="Opportunities" value={opportunities.length} />
        <Stat label="Won" value={opportunities.filter((o) => o.status === 'won').length} color="emerald" />
        <Stat label="Lost" value={opportunities.filter((o) => o.status === 'lost').length} color="red" />
        <Stat label="Won $" value={fmtDollars(wonValue)} color="emerald" />
      </div>

      {/* Opps */}
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">Opportunities</h3>
      {opportunities.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No opportunities linked yet.</p>
      ) : (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
          {opportunities.map((o) => (
            <Link
              key={o.id}
              href={`/opportunity/${o.id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{o.title}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {o.agency && <span>{o.agency} · </span>}
                  {fmtDate(o.response_deadline)}
                  {o.estimated_value != null && <span> · {fmtDollars(o.estimated_value)}</span>}
                </p>
              </div>
              <StatusBadge status={o.status as OpportunityStatus} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  const c = color === "emerald" ? "text-emerald-600 dark:text-emerald-400"
    : color === "red" ? "text-red-600 dark:text-red-400"
    : "text-slate-900 dark:text-white";
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">{label}</p>
      <p className={`text-xl font-bold ${c}`}>{value}</p>
    </div>
  );
}
