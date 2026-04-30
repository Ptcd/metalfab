import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET /api/takeoff/similar?category=lintel&excludeOpp=<id>&limit=5
//
// Returns the closest historical takeoff lines for a given category,
// scored by category match + token-overlap on the description, with
// actuals joined when available.
//
// This is the v1 of similar-job memory — no embedding service yet.
// Once N>10 bids of historical data exist, swap the scorer for cosine
// similarity on description embeddings (schema is forward-compatible).
//
// Query params:
//   category    — required. Matches takeoff_lines.category exactly.
//   description — optional. Used for token-overlap scoring.
//   excludeOpp  — optional. Skip lines from this opportunity (so a
//                 line doesn't match itself).
//   limit       — optional. Default 5.
export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const description = url.searchParams.get('description') || '';
  const excludeOpp = url.searchParams.get('excludeOpp');
  const limit = Math.min(20, parseInt(url.searchParams.get('limit') || '5', 10));

  if (!category) {
    return NextResponse.json({ error: 'category required' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Pull all historical lines in this category, joining the run's
  // opportunity for context + the actuals row if any.
  let q = supabase
    .from('takeoff_lines')
    .select(`
      id, line_no, category, description, quantity, quantity_unit,
      total_weight_lbs, fab_hrs, det_hrs, foreman_hrs, ironworker_hrs,
      finish, line_total_usd, confidence,
      takeoff_runs!inner ( id, opportunity_id, generated_at, status,
                            opportunities!inner ( id, title ) )
    `)
    .eq('category', category)
    .order('id', { ascending: false })
    .limit(200);
  const { data: lines, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Pull actuals for any of those lines
  const lineIds = (lines || []).map((l) => l.id);
  let actuals: Record<string, unknown>[] = [];
  if (lineIds.length) {
    const { data } = await supabase
      .from('bid_actuals')
      .select('takeoff_line_id, actual_total_weight_lbs, actual_fab_hrs, actual_ironworker_hrs, actual_total_cost_usd, weight_delta_pct, ironworker_delta_pct, total_delta_pct')
      .in('takeoff_line_id', lineIds);
    actuals = data || [];
  }
  const actualByLineId = new Map(actuals.map((a) => [String(a.takeoff_line_id), a]));

  // Score: token overlap on description (case-insensitive, ignoring
  // common stopwords and ≤2-char tokens). Filter out the excludeOpp.
  const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'per', 'from', 'into', 'each', 'item']);
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
  const queryTokens = tokenize(description);

  const scored = (lines || [])
    .filter((l) => {
      const run = l.takeoff_runs as unknown as { opportunity_id: string } | null;
      return run?.opportunity_id !== excludeOpp;
    })
    .map((l) => {
      const lineTokens = tokenize(l.description || '');
      let overlap = 0;
      queryTokens.forEach((t) => { if (lineTokens.has(t)) overlap++; });
      const overlapScore = queryTokens.size > 0 ? overlap / queryTokens.size : 0;
      // Slight penalty for very low-confidence historical lines (those
      // were assumption-driven; their numbers are less informative)
      const confBoost = Math.min(1.0, Number(l.confidence || 0.5) + 0.3);
      const score = overlapScore * 0.7 + confBoost * 0.3;
      return { line: l, score, overlap };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ line, score, overlap }) => {
      const run = line.takeoff_runs as unknown as { id: string; opportunity_id: string; status: string; generated_at: string; opportunities: { id: string; title: string } | null } | null;
      const a = actualByLineId.get(String(line.id));
      return {
        id: line.id,
        score,
        token_overlap: overlap,
        category: line.category,
        description: line.description,
        quantity: line.quantity,
        quantity_unit: line.quantity_unit,
        total_weight_lbs: line.total_weight_lbs,
        fab_hrs: line.fab_hrs,
        ironworker_hrs: line.ironworker_hrs,
        finish: line.finish,
        line_total_usd: line.line_total_usd,
        confidence: line.confidence,
        opportunity: run?.opportunities ? {
          id: run.opportunities.id,
          title: run.opportunities.title,
        } : null,
        run_status: run?.status,
        actual: a ? {
          weight_lbs:    a.actual_total_weight_lbs,
          fab_hrs:       a.actual_fab_hrs,
          ironworker_hrs: a.actual_ironworker_hrs,
          total_cost_usd: a.actual_total_cost_usd,
          weight_delta_pct: a.weight_delta_pct,
          iw_delta_pct:     a.ironworker_delta_pct,
          total_delta_pct:  a.total_delta_pct,
        } : null,
      };
    });

  return NextResponse.json({
    data: {
      query: { category, description, limit },
      total_candidates: lines?.length || 0,
      results: scored,
      note: scored.length < 3
        ? 'Memory limited: <3 matching historical lines. Add more historical bids and won-job actuals to improve match quality.'
        : undefined,
    },
  });
}
