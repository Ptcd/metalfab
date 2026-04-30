import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const CONFIDENCE_FLOOR = 0.50;       // Lines below this block approval unless overridden

// POST /api/opportunities/[id]/takeoff/approve
//
// Body: { run_id, scenario, bid_total_usd, force?: boolean,
//         override_low_confidence?: { line_no: number, reason: string }[] }
//
// Approval gates:
//   1. Plan Intelligence has run (plan_intelligence row exists for this opp)
//   2. Audit has run (takeoff_audits row exists for this takeoff_run)
//   3. No takeoff line is below CONFIDENCE_FLOOR (0.50) without an
//      explicit per-line override w/ reason
//   4. Audit verdict isn't 'block_submission'
// `force=true` skips the gates but logs the override into pipeline_events
// (still requires explicit caller flag).
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: {
    run_id?: string;
    scenario?: string;
    bid_total_usd?: number;
    force?: boolean;
    override_low_confidence?: { line_no: number; reason: string }[];
  };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.run_id || !body.scenario || typeof body.bid_total_usd !== 'number') {
    return NextResponse.json({ error: 'run_id, scenario, bid_total_usd required' }, { status: 400 });
  }
  if (!['conservative', 'expected', 'aggressive'].includes(body.scenario)) {
    return NextResponse.json({ error: 'invalid scenario' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // ---- Pre-flight checklist --------------------------------------------
  if (!body.force) {
    const blockers: string[] = [];

    // (1) Plan Intelligence has run
    const { data: pi } = await supabase
      .from('plan_intelligence')
      .select('id, generated_at')
      .eq('opportunity_id', params.id)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!pi) blockers.push('Plan Intelligence has not run for this opportunity');

    // (2) Audit has run for this run
    const { data: audit } = await supabase
      .from('takeoff_audits')
      .select('id, verdict, errors_count')
      .eq('takeoff_run_id', body.run_id)
      .maybeSingle();
    if (!audit) blockers.push('Takeoff audit has not run for this takeoff_run');
    else if (audit.verdict === 'block_submission') {
      blockers.push(`Audit verdict is 'block_submission' (${audit.errors_count} errors). Resolve before approving.`);
    }

    // (3) Confidence floor — every line ≥ 0.50 unless explicitly overridden
    const { data: lines } = await supabase
      .from('takeoff_lines')
      .select('line_no, category, confidence')
      .eq('takeoff_run_id', body.run_id);
    const lowConf = (lines || []).filter((l) => Number(l.confidence) < CONFIDENCE_FLOOR);
    const overrides = new Map(
      (body.override_low_confidence || []).map((o) => [o.line_no, o.reason])
    );
    const unrationalized = lowConf.filter((l) => !overrides.has(l.line_no));
    if (unrationalized.length > 0) {
      blockers.push(
        `${unrationalized.length} line(s) below confidence floor ${CONFIDENCE_FLOOR}: ` +
        unrationalized.map((l) => `#${l.line_no} ${l.category} (${(Number(l.confidence) * 100).toFixed(0)}%)`).join(', ') +
        '. Provide override_low_confidence: [{line_no, reason}] for each, or use force=true.'
      );
    }

    if (blockers.length > 0) {
      return NextResponse.json({
        error: 'preflight_blocked',
        message: 'Approval blocked by pre-flight checks',
        blockers,
        confidence_floor: CONFIDENCE_FLOOR,
        low_confidence_lines: lowConf.map((l) => ({
          line_no: l.line_no,
          category: l.category,
          confidence: l.confidence,
        })),
      }, { status: 422 });
    }
  }

  // ---- Approve --------------------------------------------------------
  const update: Record<string, unknown> = {
    status: 'approved',
    bid_total_usd: body.bid_total_usd,
  };
  if (body.scenario === 'conservative') update.conservative_bid_usd = body.bid_total_usd;
  if (body.scenario === 'expected')     update.expected_bid_usd     = body.bid_total_usd;
  if (body.scenario === 'aggressive')   update.aggressive_bid_usd   = body.bid_total_usd;

  const { error: updErr } = await supabase
    .from('takeoff_runs')
    .update(update)
    .eq('id', body.run_id)
    .eq('opportunity_id', params.id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Pipeline event captures any overrides for audit history. The
  // pipeline_events table has only old_value / new_value text columns
  // — we encode any override note into new_value.
  const overrideNote = body.force
    ? ` [force=true skipped preflight, by ${user.id}]`
    : (body.override_low_confidence?.length
        ? ` [low-conf overrides: ${body.override_low_confidence.map((o) => `L${o.line_no}: ${o.reason}`).join('; ')}]`
        : '');
  await supabase.from('pipeline_events').insert({
    opportunity_id: params.id,
    event_type: body.force ? 'takeoff_force_approved' : 'takeoff_approved',
    new_value: `${body.scenario}:$${body.bid_total_usd.toFixed(0)}${overrideNote}`,
  });

  return NextResponse.json({ data: { ok: true } });
}
