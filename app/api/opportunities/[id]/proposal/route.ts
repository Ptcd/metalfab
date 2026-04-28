import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET /api/opportunities/[id]/proposal
// Returns the latest proposal record for this opportunity (or null).
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  const { data: prop, error } = await supabase
    .from('proposals')
    .select('*')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: prop });
}
