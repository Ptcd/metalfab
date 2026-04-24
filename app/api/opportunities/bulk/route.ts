import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { purgeOpportunityDocuments } = require('../../../../lib/documents');

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ALLOWED_STATUSES = new Set([
  'new', 'reviewing', 'awaiting_qa', 'qa_qualified', 'qa_rejected',
  'bidding', 'won', 'lost', 'passed',
]);
const PURGE_ON = new Set(['passed', 'qa_rejected', 'lost']);

/**
 * POST /api/opportunities/bulk
 * Body: { ids: string[], status: OpportunityStatus, note?: string }
 *
 * Batch-updates status for a set of opps. If the target status is one that
 * typically purges docs (passed/qa_rejected/lost), documents are purged too.
 * Logs a pipeline_event per opp.
 */
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { ids?: unknown; status?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? (body.ids as string[]) : [];
  const status = typeof body.status === 'string' ? body.status : '';
  const note = typeof body.note === 'string' ? body.note : '';

  if (ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 });
  if (ids.length > 200) return NextResponse.json({ error: 'max 200 ids per call' }, { status: 400 });
  if (!ALLOWED_STATUSES.has(status)) {
    return NextResponse.json({ error: `invalid status: ${status}` }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: current } = await supabase
    .from('opportunities')
    .select('id, status')
    .in('id', ids);

  const idSet = new Set((current ?? []).map((r) => r.id));
  const found = ids.filter((id) => idSet.has(id));

  // Update all in one shot
  const patch: Record<string, unknown> = { status };
  if (note) patch.notes = note;

  const { error } = await supabase.from('opportunities').update(patch).in('id', found);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log events
  const events = (current ?? []).map((row) => ({
    opportunity_id: row.id,
    event_type: 'status_change' as const,
    old_value: row.status,
    new_value: status,
  }));
  if (events.length) await supabase.from('pipeline_events').insert(events);

  // Purge docs if status warrants it
  let purged = 0;
  if (PURGE_ON.has(status)) {
    for (const id of found) {
      try {
        purged += await purgeOpportunityDocuments(id);
      } catch (e) {
        console.error(`bulk purge ${id}:`, e);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    updated: found.length,
    purged_docs: purged,
    not_found: ids.length - found.length,
  });
}
