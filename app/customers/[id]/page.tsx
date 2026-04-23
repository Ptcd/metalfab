import { createServiceClient } from "@/lib/db/supabase";
import { notFound } from "next/navigation";
import { Customer, OpportunityStatus } from "@/types/opportunity";
import { CustomerDetail } from "./CustomerDetail";

export const dynamic = "force-dynamic";

interface OppRow {
  id: string;
  title: string;
  status: OpportunityStatus;
  score: number;
  response_deadline: string | null;
  estimated_value: number | null;
  updated_at: string;
  agency: string | null;
}

export default async function CustomerDetailPage({ params }: { params: { id: string } }) {
  const supabase = createServiceClient();

  const [{ data: customer }, { data: opps }] = await Promise.all([
    supabase.from("customers").select("*").eq("id", params.id).single(),
    supabase
      .from("opportunities")
      .select("id, title, status, score, response_deadline, estimated_value, updated_at, agency")
      .eq("customer_id", params.id)
      .order("updated_at", { ascending: false }),
  ]);

  if (!customer) notFound();

  return (
    <CustomerDetail
      customer={customer as Customer}
      opportunities={(opps ?? []) as OppRow[]}
    />
  );
}
