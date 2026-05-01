import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import { buildManifest } from '@/lib/coverage';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/opportunities/[id]/coverage/run
 *
 * Runs the deterministic coverage-manifest builder for this opp:
 *   - Loads the latest plan_intelligence digest.
 *   - Calls lib/coverage/buildManifest(digest).
 *   - Upserts to coverage_manifests.
 *
 * Returns { ok, summary, unresolved_count, needs_vision_count } for
 * the button to display, plus blockers if the prerequisite (plan
 * intelligence) hasn't run yet.
 *
 * No CLI needed — this is the in-browser equivalent of
 * `node scripts/coverage.js --opp=<id>`.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  // 1. Load digest. Without plan_intelligence we can't build a manifest.
  const { data: pi, error: piErr } = await supabase
    .from('plan_intelligence')
    .select('digest, generated_at')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (piErr) {
    return NextResponse.json({ ok: false, error: `plan_intelligence load: ${piErr.message}` }, { status: 500 });
  }
  if (!pi || !pi.digest) {
    return NextResponse.json({
      ok: false,
      error: 'No plan_intelligence digest for this opportunity yet. Run plan-intelligence first (CLI: node scripts/plan-intelligence.js --opp=' + params.id + ').',
      blocker: 'plan_intelligence_missing',
    }, { status: 409 });
  }

  // 2. Build the manifest. Pure function — no I/O.
  let manifest;
  try {
    manifest = buildManifest(pi.digest);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `manifest build failed: ${msg}` }, { status: 500 });
  }

  // 3. Upsert. The unique constraint on opportunity_id means a re-run
  //    overwrites the prior manifest — desired behavior; only the
  //    latest matters.
  const row = {
    opportunity_id: params.id,
    manifest,
    summary: manifest.summary,
    unresolved_count: manifest.unresolved.length,
    needs_vision_count: manifest.summary.needs_vision_count,
    generated_at: manifest.generated_at,
  };
  const { error: upsertErr } = await supabase
    .from('coverage_manifests')
    .upsert(row, { onConflict: 'opportunity_id' });
  if (upsertErr) {
    // Most common failure mode: migration 017 hasn't been applied yet.
    const migrationHint = /relation .*coverage_manifests.* does not exist/i.test(upsertErr.message)
      ? ' — apply supabase/migrations/017_coverage_manifests.sql in the Supabase SQL Editor first.'
      : '';
    return NextResponse.json({
      ok: false,
      error: `coverage_manifests upsert: ${upsertErr.message}${migrationHint}`,
      blocker: migrationHint ? 'migration_missing' : null,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    summary: manifest.summary,
    unresolved_count: manifest.unresolved.length,
    needs_vision_count: manifest.summary.needs_vision_count,
    expected_categories: manifest.expected_categories,
    plan_intelligence_generated_at: pi.generated_at,
  });
}

/**
 * GET /api/opportunities/[id]/coverage/run
 *
 * Returns the current manifest summary (or a blocker reason) without
 * rebuilding. Used by the button to render its state on page load.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  const { data: pi } = await supabase
    .from('plan_intelligence')
    .select('id, generated_at')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: cm, error: cmErr } = await supabase
    .from('coverage_manifests')
    .select('summary, unresolved_count, needs_vision_count, generated_at')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Surface the migration-missing case clearly so the button can show
  // a helpful action rather than a cryptic error.
  if (cmErr && /relation .*coverage_manifests.* does not exist/i.test(cmErr.message)) {
    return NextResponse.json({
      ok: true,
      manifest: null,
      has_plan_intelligence: !!pi,
      migration_missing: true,
    });
  }

  return NextResponse.json({
    ok: true,
    manifest: cm || null,
    has_plan_intelligence: !!pi,
    migration_missing: false,
  });
}
