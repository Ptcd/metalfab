import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const supabase = createServiceClient();
  const params = request.nextUrl.searchParams;
  const limit = Math.min(parseInt(params.get('limit') ?? '50'), 200);
  const offset = parseInt(params.get('offset') ?? '0');

  const { data, error, count } = await supabase
    .from('pipeline_events')
    .select(
      `
      *,
      opportunities!inner(id, title, agency)
    `,
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data, count, limit, offset });
}
