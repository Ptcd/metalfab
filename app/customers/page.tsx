import { createServiceClient } from "@/lib/db/supabase";
import Link from "next/link";
import { Customer } from "@/types/opportunity";
import { CustomersClient } from "./CustomersClient";

export const dynamic = "force-dynamic";

type CustomerRow = Customer & { opportunities?: { status: string }[] };

export default async function CustomersPage() {
  const supabase = createServiceClient();

  const { data } = await supabase
    .from("customers")
    .select("*, opportunities:opportunities(status)")
    .order("last_contact", { ascending: false, nullsFirst: false })
    .order("name");

  const customers: CustomerRow[] = (data as CustomerRow[] | null) ?? [];

  const enriched = customers.map((c) => {
    const opps = c.opportunities || [];
    const counts = { total: opps.length, won: 0, lost: 0, bidding: 0, active: 0 };
    for (const o of opps) {
      if (o.status === 'won') counts.won++;
      else if (o.status === 'lost') counts.lost++;
      else if (o.status === 'bidding') counts.bidding++;
      if (['reviewing','awaiting_qa','qa_qualified','bidding'].includes(o.status)) counts.active++;
    }
    return { ...c, _counts: counts };
  });

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Customers</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            GCs, referrers, repeat buyers — {enriched.length} entries
          </p>
        </div>
        <Link
          href="/customers?new=1"
          className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
        >
          + New Customer
        </Link>
      </div>

      <CustomersClient customers={enriched} />
    </div>
  );
}
