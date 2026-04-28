import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import { generateProposal, ProposalInput } from '@/lib/proposal/generate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PROPOSALS_BUCKET = 'bid-docs';

// POST /api/opportunities/[id]/proposal/generate
//
// Generates a proposal PDF from the latest *approved* takeoff_run for
// this opportunity. Persists to Supabase Storage and inserts a row in
// `proposals`. Returns the proposal record + a signed URL for the PDF.
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

  // Latest approved takeoff
  const { data: run } = await supabase
    .from('takeoff_runs')
    .select('*')
    .eq('opportunity_id', params.id)
    .eq('status', 'approved')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: 'No approved takeoff yet' }, { status: 400 });

  const { data: lines } = await supabase
    .from('takeoff_lines')
    .select('*')
    .eq('takeoff_run_id', run.id)
    .order('line_no', { ascending: true });

  const rawOutput = (run.raw_output || {}) as {
    scope_summary?: string;
    exclusions?: string[];
    rfis_recommended?: string[];
  };
  const scopeSummary = rawOutput.scope_summary || run.notes || `TCB metal fabrications scope per spec sections identified by Plan Intelligence.`;

  // Pull explicit assumption notes from flagged lines
  const flaggedAssumptions = (lines || [])
    .filter((l) => l.flagged_for_review && l.assumptions)
    .map((l) => `Line ${l.line_no} (${l.category}): ${l.assumptions}`);

  // Determine which scenario was approved (the one whose snapshot column
  // matches bid_total_usd). Fallback to 'expected' if column nulls don't
  // line up.
  let scenario: 'conservative' | 'expected' | 'aggressive' = 'expected';
  if (run.bid_total_usd && run.conservative_bid_usd === run.bid_total_usd) scenario = 'conservative';
  else if (run.bid_total_usd && run.aggressive_bid_usd === run.bid_total_usd) scenario = 'aggressive';

  // Allocate the next proposal number
  const year = new Date().getFullYear();
  const { data: nextNum, error: numErr } = await supabase.rpc('next_proposal_number', { year_in: year });
  if (numErr) return NextResponse.json({ error: `proposal number rpc failed: ${numErr.message}` }, { status: 500 });
  const proposalNumber = `TCB-${year}-${String(nextNum).padStart(4, '0')}`;

  const generatedAt = new Date();
  const input: ProposalInput = {
    proposal_number:    proposalNumber,
    generated_at:       generatedAt,
    project_name:       opp.title,
    gc_name:            opp.agency,
    project_location:   opp.place_of_performance,
    scenario,
    bid_total_usd:      Number(run.bid_total_usd),
    scope_summary:      scopeSummary,
    lines:              (lines || []).map((l) => ({
      line_no:        l.line_no,
      category:       l.category,
      description:    l.description,
      quantity:       Number(l.quantity),
      quantity_unit:  l.quantity_unit,
      finish:         l.finish,
    })),
    exclusions:         rawOutput.exclusions || [],
    clarifications:     rawOutput.rfis_recommended || [],
    flagged_assumptions: flaggedAssumptions,
  };

  const pdfBytes = await generateProposal(input);
  const filename = `${proposalNumber}.pdf`;
  const storagePath = `${params.id}/proposals/${filename}`;

  const { error: upErr } = await supabase
    .storage
    .from(PROPOSALS_BUCKET)
    .upload(storagePath, pdfBytes, {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (upErr) return NextResponse.json({ error: `storage upload: ${upErr.message}` }, { status: 500 });

  const { data: prop, error: insErr } = await supabase
    .from('proposals')
    .insert({
      opportunity_id:   params.id,
      takeoff_run_id:   run.id,
      proposal_number:  proposalNumber,
      scenario,
      bid_total_usd:    Number(run.bid_total_usd),
      storage_path:     storagePath,
      filename,
      file_size:        pdfBytes.byteLength,
      generator_version: 'proposal-pdf-v1',
      generated_by:     user.id,
    })
    .select()
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type:     'proposal_generated',
    new_value:      `${proposalNumber}:$${Number(run.bid_total_usd).toFixed(0)}`,
  });

  return NextResponse.json({ data: prop });
}
