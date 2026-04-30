import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const CONFIDENCE_FLOOR = 0.50;

// GET /api/opportunities/[id]/takeoff/preflight
//
// Returns the pre-flight checklist state without attempting approval.
// The UI uses this to render the checklist + disable the Approve
// button until all gates pass (or force/override is acknowledged).
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  // Latest takeoff_run
  const { data: run } = await supabase
    .from('takeoff_runs')
    .select('id, status')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) {
    return NextResponse.json({ data: { ready: false, blockers: ['no takeoff_run yet'], checks: [] } });
  }

  // Plan Intelligence
  const { data: pi } = await supabase
    .from('plan_intelligence')
    .select('id, generated_at, summary')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Audit
  const { data: audit } = await supabase
    .from('takeoff_audits')
    .select('id, verdict, errors_count, warnings_count, generated_at')
    .eq('takeoff_run_id', run.id)
    .maybeSingle();

  // Lines + low-confidence
  const { data: lines } = await supabase
    .from('takeoff_lines')
    .select('line_no, category, confidence')
    .eq('takeoff_run_id', run.id);
  const lowConf = (lines || [])
    .filter((l) => Number(l.confidence) < CONFIDENCE_FLOOR)
    .map((l) => ({ line_no: l.line_no, category: l.category, confidence: l.confidence }));

  const checks = [
    {
      name: 'plan_intelligence',
      label: 'Plan Intelligence has processed the package',
      pass: !!pi,
      detail: pi ? `Last run: ${new Date(pi.generated_at).toLocaleString()}` : 'Run scripts/plan-intelligence.js',
    },
    {
      name: 'takeoff',
      label: 'Takeoff lines exist',
      pass: (lines?.length || 0) > 0,
      detail: `${lines?.length || 0} lines`,
    },
    {
      name: 'audit',
      label: 'Audit Agent has reviewed the takeoff',
      pass: !!audit,
      detail: audit ? `${audit.verdict} (${audit.errors_count} err / ${audit.warnings_count} warn)` : 'Run scripts/audit-prepare.js + audit-commit.js',
    },
    {
      name: 'audit_not_blocking',
      label: 'Audit verdict is not block_submission',
      pass: !audit || audit.verdict !== 'block_submission',
      detail: audit?.verdict === 'block_submission' ? `Resolve ${audit.errors_count} error-severity findings` : '',
    },
    {
      name: 'confidence_floor',
      label: `Every line ≥ ${(CONFIDENCE_FLOOR * 100).toFixed(0)}% confidence`,
      pass: lowConf.length === 0,
      detail: lowConf.length === 0
        ? 'All lines meet the floor'
        : `${lowConf.length} line(s) below floor: ${lowConf.slice(0, 3).map((l) => `#${l.line_no}@${(Number(l.confidence) * 100).toFixed(0)}%`).join(', ')}${lowConf.length > 3 ? '…' : ''}`,
    },
  ];

  const ready = checks.every((c) => c.pass);
  const blockers = checks.filter((c) => !c.pass).map((c) => c.label);

  return NextResponse.json({
    data: {
      ready,
      blockers,
      checks,
      low_confidence_lines: lowConf,
      confidence_floor: CONFIDENCE_FLOOR,
      run_status: run.status,
    },
  });
}
