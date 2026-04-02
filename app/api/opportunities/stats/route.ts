import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createServiceClient();

  // Count by status
  const { data: allOpps } = await supabase
    .from('opportunities')
    .select('status');

  const statusCounts: Record<string, number> = {
    new: 0,
    reviewing: 0,
    bidding: 0,
    won: 0,
    lost: 0,
    passed: 0,
  };

  for (const opp of allOpps ?? []) {
    statusCounts[opp.status] = (statusCounts[opp.status] ?? 0) + 1;
  }

  // Upcoming deadlines (next 14 days)
  const now = new Date();
  const twoWeeks = new Date(now);
  twoWeeks.setDate(twoWeeks.getDate() + 14);

  const { data: upcoming } = await supabase
    .from('opportunities')
    .select('id, title, agency, response_deadline, score, status')
    .gte('response_deadline', now.toISOString())
    .lte('response_deadline', twoWeeks.toISOString())
    .in('status', ['new', 'reviewing', 'bidding'])
    .order('response_deadline', { ascending: true })
    .limit(20);

  // Won/lost this month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { data: monthOpps } = await supabase
    .from('opportunities')
    .select('status')
    .gte('updated_at', monthStart)
    .in('status', ['won', 'lost']);

  const wonThisMonth = (monthOpps ?? []).filter((o) => o.status === 'won').length;
  const lostThisMonth = (monthOpps ?? []).filter((o) => o.status === 'lost').length;

  return NextResponse.json({
    statusCounts,
    totalActive: statusCounts.new + statusCounts.reviewing + statusCounts.bidding,
    biddingCount: statusCounts.bidding,
    wonThisMonth,
    lostThisMonth,
    upcomingDeadlines: upcoming ?? [],
  });
}
