import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import { computeScenarios, RateCard, TakeoffLine } from '@/lib/takeoff/scenarios';

export const dynamic = 'force-dynamic';

// GET /api/opportunities/[id]/takeoff
//
// Returns the latest takeoff_run for this opp, its lines, the
// associated audit (if any), and the three priced scenarios
// (conservative / expected / aggressive). Used by the opportunity
// detail page's review screen.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  const { data: run, error: runErr } = await supabase
    .from('takeoff_runs')
    .select('*')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runErr) return NextResponse.json({ error: runErr.message }, { status: 500 });
  if (!run) return NextResponse.json({ data: null });

  const [{ data: lines }, { data: audit }, { data: rate }] = await Promise.all([
    supabase
      .from('takeoff_lines')
      .select('*')
      .eq('takeoff_run_id', run.id)
      .order('line_no', { ascending: true }),
    supabase
      .from('takeoff_audits')
      .select('*')
      .eq('takeoff_run_id', run.id)
      .maybeSingle(),
    run.rate_card_version_id
      ? supabase.from('rate_card_versions').select('*').eq('id', run.rate_card_version_id).maybeSingle()
      : supabase.from('rate_card_versions').select('*').is('effective_to', null).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
  ]);

  if (!rate) return NextResponse.json({ error: 'no rate card' }, { status: 500 });

  const scenarios = computeScenarios((lines || []) as TakeoffLine[], rate as RateCard);

  return NextResponse.json({
    data: {
      run,
      lines: lines || [],
      audit: audit || null,
      rate_card: rate,
      scenarios,
    },
  });
}
