import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { scoreOpportunity } from '@/lib/scoring/engine';
import { ScoringConfig } from '@/types/scoring';

export const dynamic = 'force-dynamic';

// GET /api/opportunities — list with filters
export async function GET(request: NextRequest) {
  const supabase = createServiceClient();
  const params = request.nextUrl.searchParams;

  let query = supabase
    .from('opportunities')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  // Filters
  const status = params.get('status');
  if (status) query = query.eq('status', status);

  const scoreMin = params.get('score_min');
  if (scoreMin) query = query.gte('score', parseInt(scoreMin));

  const scoreMax = params.get('score_max');
  if (scoreMax) query = query.lte('score', parseInt(scoreMax));

  const deadlineBefore = params.get('deadline_before');
  if (deadlineBefore) query = query.lte('response_deadline', deadlineBefore);

  const deadlineAfter = params.get('deadline_after');
  if (deadlineAfter) query = query.gte('response_deadline', deadlineAfter);

  const source = params.get('source');
  if (source) query = query.eq('source', source);

  const search = params.get('search');
  if (search) query = query.or(`title.ilike.%${search}%,agency.ilike.%${search}%`);

  // Pagination
  const limit = Math.min(parseInt(params.get('limit') ?? '50'), 200);
  const offset = parseInt(params.get('offset') ?? '0');
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data, count, limit, offset });
}

// POST /api/opportunities — create manual opportunity
export async function POST(request: NextRequest) {
  const supabase = createServiceClient();

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  // Load scoring config
  const { data: configData } = await supabase
    .from('scoring_config')
    .select('*')
    .limit(1)
    .single();

  const config = configData as ScoringConfig;

  // Score the opportunity
  const { score, signals } = scoreOpportunity(
    {
      title: body.title,
      description: body.description ?? null,
      naics_code: body.naics_code ?? null,
      dollar_min: body.dollar_min ?? null,
      dollar_max: body.dollar_max ?? null,
    },
    config
  );

  const record = {
    title: body.title,
    description: body.description ?? null,
    agency: body.agency ?? null,
    sub_agency: body.sub_agency ?? null,
    naics_code: body.naics_code ?? null,
    naics_description: body.naics_description ?? null,
    dollar_min: body.dollar_min ?? null,
    dollar_max: body.dollar_max ?? null,
    posted_date: body.posted_date ?? new Date().toISOString().split('T')[0],
    response_deadline: body.response_deadline ?? null,
    point_of_contact: body.point_of_contact ?? null,
    contact_email: body.contact_email ?? null,
    source_url: body.source_url ?? null,
    source: body.source ?? 'manual',
    notes: body.notes ?? null,
    score,
    score_signals: signals,
    status: 'new' as const,
  };

  const { data, error } = await supabase
    .from('opportunities')
    .insert(record)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Log creation event
  await supabase.from('pipeline_events').insert({
    opportunity_id: data.id,
    event_type: 'created',
    new_value: 'new',
  });

  return NextResponse.json({ data }, { status: 201 });
}
