import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import { generateNestleBidForm } from '@/lib/proposal/nestle-bid-form';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PROPOSALS_BUCKET = 'bid-docs';

// POST /api/opportunities/[id]/proposal/bid-form
//
// Generates a filled-in GC Bid Form xlsx (Nestle/Camosy template
// format) from the latest takeoff_run for this opportunity. Persists
// to Supabase Storage and inserts a `proposals` row tagged with
// generator_version='nestle-bid-form-v1'. Returns the proposal record.
//
// Unlike /proposal/generate (PDF) this route does NOT require the
// takeoff to be approved — the GC bid form is often generated from a
// draft to aid the approval review.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  const { data: opp, error: oppErr } = await supabase
    .from('opportunities')
    .select('id, title, agency, place_of_performance')
    .eq('id', params.id)
    .single();
  if (oppErr || !opp) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });

  // Latest takeoff run regardless of status — newest first.
  const { data: run } = await supabase
    .from('takeoff_runs')
    .select('*')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: 'No takeoff runs yet' }, { status: 400 });

  const { data: lines } = await supabase
    .from('takeoff_lines')
    .select('line_no, category, description, quantity, quantity_unit, line_total_usd')
    .eq('takeoff_run_id', run.id)
    .order('line_no', { ascending: true });

  const { data: rateCard } = await supabase
    .from('rate_card_versions')
    .select('foreman_per_hr, ironworker_per_hr, fab_per_hr')
    .is('effective_to', null)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();

  const subtotal = (lines || []).reduce((s, l) => s + (Number(l.line_total_usd) || 0), 0);

  const year = new Date().getFullYear();
  const { data: nextNum, error: numErr } = await supabase.rpc('next_proposal_number', { year_in: year });
  if (numErr) return NextResponse.json({ error: `proposal number rpc failed: ${numErr.message}` }, { status: 500 });
  const proposalNumber = `TCB-${year}-${String(nextNum).padStart(4, '0')}-XLSX`;

  let bidFormBuffer: Buffer;
  try {
    bidFormBuffer = generateNestleBidForm({
      lines: (lines || []).map((l: { line_no: number; category: string; description: string; quantity: number | string | null; quantity_unit: string | null; line_total_usd: number | string | null }) => ({
        line_no:        l.line_no,
        category:       l.category,
        description:    l.description,
        quantity:       Number(l.quantity),
        quantity_unit:  l.quantity_unit,
        line_total_usd: Number(l.line_total_usd) || 0,
      })),
      bid_total_usd:  Number(run.bid_total_usd),
      subtotal_usd:   subtotal,
      rate_card: {
        foreman_per_hr:    Number(rateCard?.foreman_per_hr) || 0,
        ironworker_per_hr: Number(rateCard?.ironworker_per_hr) || 0,
        fab_per_hr:        Number(rateCard?.fab_per_hr) || 0,
      },
      project: {
        project_name:           opp.title,
        sf:                     null,
        substantial_completion: null,
        commencement:           null,
      },
      proposal_number: proposalNumber,
      open_rfis:       [],
      generated_at:    new Date().toISOString(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `bid form generation: ${msg}` }, { status: 500 });
  }

  const filename = `${proposalNumber}.xlsx`;
  const storagePath = `${params.id}/bid-forms/${filename}`;

  const { error: upErr } = await supabase
    .storage
    .from(PROPOSALS_BUCKET)
    .upload(storagePath, bidFormBuffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: true,
    });
  if (upErr) return NextResponse.json({ error: `storage upload: ${upErr.message}` }, { status: 500 });

  const { data: prop, error: insErr } = await supabase
    .from('proposals')
    .insert({
      opportunity_id:    params.id,
      takeoff_run_id:    run.id,
      proposal_number:   proposalNumber,
      scenario:          'expected',
      bid_total_usd:     Number(run.bid_total_usd),
      storage_path:      storagePath,
      filename,
      file_size:         bidFormBuffer.byteLength,
      generator_version: 'nestle-bid-form-v1',
      generated_by:      user.id,
    })
    .select()
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type:     'bid_form_generated',
    new_value:      `${proposalNumber}:$${Number(run.bid_total_usd).toFixed(0)}`,
  });

  return NextResponse.json({ data: prop });
}
