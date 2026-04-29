import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import { generateRFIs, formatRFIList, TakeoffLineForRFI } from '@/lib/takeoff/rfi';

export const dynamic = 'force-dynamic';

// GET /api/opportunities/[id]/takeoff/rfi
//
// Returns the auto-drafted RFI list for the latest takeoff_run on
// this opportunity. One RFI per takeoff line that is below the
// confidence threshold or flagged_for_review.
//
// Response: { rfis: RFIQuestion[], formatted_list: string }
// formatted_list is a paste-ready string for Camosy / Bonfire / email.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  const { data: run } = await supabase
    .from('takeoff_runs')
    .select('id')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return NextResponse.json({ data: { rfis: [], formatted_list: '' } });

  const { data: lines } = await supabase
    .from('takeoff_lines')
    .select('line_no, category, description, quantity, quantity_unit, quantity_band, quantity_min, quantity_max, steel_shape_designation, source_kind, source_section, source_page, source_evidence, confidence, flagged_for_review, assumptions')
    .eq('takeoff_run_id', run.id)
    .order('line_no', { ascending: true });

  const { data: opp } = await supabase
    .from('opportunities')
    .select('title')
    .eq('id', params.id)
    .single();

  const url = new URL(request.url);
  const thresholdParam = url.searchParams.get('threshold');
  const threshold = thresholdParam ? parseFloat(thresholdParam) : 0.70;

  const rfis = generateRFIs(
    (lines || []) as unknown as TakeoffLineForRFI[],
    { threshold },
  );
  const header =
    `RFI list for: ${opp?.title || 'this opportunity'}\n` +
    `Drafted automatically from the TCB Metalworks takeoff. Each item below is a quantity or scope detail we could not fully resolve from the bid documents and would like the GC to confirm.`;
  const formatted = formatRFIList(rfis, header);

  return NextResponse.json({ data: { rfis, formatted_list: formatted } });
}
