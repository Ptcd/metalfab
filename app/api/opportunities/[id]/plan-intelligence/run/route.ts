import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';
import { processPackage } from '@/lib/plan-intelligence';
import { parseXlsxBidForm, parsePdfBidForm, allowedCategoriesFromCsi } from '@/lib/plan-intelligence/parse-bid-form';
import os from 'os';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;   // 5 minutes — plan-intelligence on a full bid set takes 30-90s

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type DocumentRow = { filename?: string; category?: string };

async function downloadDoc(oppId: string, filename: string): Promise<Buffer> {
  const url = `${SUPABASE_URL}/storage/v1/object/bid-docs/${oppId}/${encodeURIComponent(filename)}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`storage ${filename} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * POST /api/opportunities/[id]/plan-intelligence/run
 *
 * In-browser equivalent of `node scripts/plan-intelligence.js --opp=<id>`.
 * Loads the opp's documents from Supabase Storage, runs lib/plan-intelligence
 * deterministically, persists to plan_intelligence (upsert), and returns
 * a summary the button can display.
 *
 * No CLI needed.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();

  // 1. Load opportunity + its document list.
  const { data: opp, error: oppErr } = await supabase
    .from('opportunities')
    .select('id, title, documents')
    .eq('id', params.id)
    .maybeSingle();
  if (oppErr) return NextResponse.json({ ok: false, error: `opp load: ${oppErr.message}` }, { status: 500 });
  if (!opp) return NextResponse.json({ ok: false, error: 'Opportunity not found' }, { status: 404 });

  const docs: DocumentRow[] = Array.isArray(opp.documents) ? opp.documents : [];
  if (docs.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'Opportunity has no documents to process. Upload a spec book / drawings first.',
      blocker: 'no_documents',
    }, { status: 409 });
  }

  // 2. Download every PDF (and any xlsx bid forms) into memory.
  const buffers: { filename: string; category: string | undefined; buffer: Buffer }[] = [];
  const bidFormCandidates: ({ filename: string; kind: 'pdf'; buffer: Buffer } | { filename: string; kind: 'xlsx'; tmpPath: string })[] = [];
  const fetchErrors: string[] = [];

  for (const d of docs) {
    const fn = d.filename || '';
    if (!fn) continue;
    try {
      if (/\.pdf$/i.test(fn)) {
        const buf = await downloadDoc(params.id, fn);
        buffers.push({ filename: fn, category: d.category, buffer: buf });
        if (d.category === 'form' || /bid[\s_-]?form|gc[\s_-]?bid/i.test(fn)) {
          bidFormCandidates.push({ filename: fn, kind: 'pdf', buffer: buf });
        }
      } else if (/\.xlsx?$/i.test(fn) && (d.category === 'form' || /bid[\s_-]?form|gc[\s_-]?bid/i.test(fn))) {
        const buf = await downloadDoc(params.id, fn);
        const tmpPath = path.join(os.tmpdir(), `bidform-${params.id}-${Date.now()}.xlsx`);
        fs.writeFileSync(tmpPath, buf);
        bidFormCandidates.push({ filename: fn, kind: 'xlsx', tmpPath });
      }
    } catch (e: unknown) {
      fetchErrors.push(`${fn}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (buffers.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'No PDF documents could be downloaded for this opportunity.' + (fetchErrors.length ? ` Errors: ${fetchErrors.join('; ')}` : ''),
      blocker: 'no_pdfs',
    }, { status: 409 });
  }

  // 3. Run plan-intelligence.
  let digest;
  try {
    digest = await processPackage(buffers);
  } catch (e: unknown) {
    return NextResponse.json({
      ok: false,
      error: `plan-intelligence failed: ${e instanceof Error ? e.message : String(e)}`,
    }, { status: 500 });
  }

  // 4. Bid-form CSI envelope (cross-checks takeoff line categories later).
  const bidFormCsi: { code: string; source_filename?: string }[] = [];
  for (const cand of bidFormCandidates) {
    try {
      if (cand.kind === 'xlsx') {
        const codes = parseXlsxBidForm(cand.tmpPath);
        for (const c of codes) bidFormCsi.push({ ...c, source_filename: cand.filename });
        try { fs.unlinkSync(cand.tmpPath); } catch { /* ignore cleanup failure */ }
      } else {
        const codes = await parsePdfBidForm(cand.buffer);
        for (const c of codes) bidFormCsi.push({ ...c, source_filename: cand.filename });
      }
    } catch {
      // Bid-form parsing failure is non-fatal — the digest is still useful.
    }
  }
  // Dedup by code
  const seen = new Set<string>();
  const dedupedBidFormCsi = bidFormCsi.filter((c) => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });
  // Bid-form fields aren't in plan-intelligence's static summary type — they
  // get attached after the fact, the same way scripts/plan-intelligence.js does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaryAny = digest.summary as any;
  summaryAny.bid_form_csi_codes = dedupedBidFormCsi;
  summaryAny.bid_form_allowed_categories = allowedCategoriesFromCsi(dedupedBidFormCsi);

  // 5. Upsert. Strip _pages and _fullText (large) — they're stripped already
  //    in processPackage but be defensive in case that changes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of (digest.documents as any[]) || []) {
    delete d._pages;
    delete d._fullText;
  }

  const { error: upsertErr } = await supabase
    .from('plan_intelligence')
    .upsert(
      {
        opportunity_id: params.id,
        digest,
        summary: digest.summary,
        ready_for_takeoff: digest.summary.readiness === 'ready_for_takeoff',
        generated_at: digest.generated_at,
      },
      { onConflict: 'opportunity_id' }
    );
  if (upsertErr) {
    return NextResponse.json({
      ok: false,
      error: `plan_intelligence upsert: ${upsertErr.message}`,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    summary: {
      total_documents:  digest.summary.total_documents,
      drawings:         digest.summary.drawings,
      specs:            digest.summary.specs,
      bid_stage:        digest.summary.bid_stage,
      readiness:        digest.summary.readiness,
      tcb_sections:     (digest.summary.tcb_sections || []).length,
      spec_section_index: (digest.summary.spec_section_index || []).length,
      schedules:        (digest.summary.schedules || []).length,
      bid_form_csi:     dedupedBidFormCsi.length,
    },
    fetch_errors: fetchErrors,
    generated_at: digest.generated_at,
  });
}

/**
 * GET /api/opportunities/[id]/plan-intelligence/run
 *
 * Returns whether plan-intelligence has run for this opp + when, so the
 * button can show "Re-run" with a date instead of just "Run".
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data: pi } = await supabase
    .from('plan_intelligence')
    .select('id, generated_at, summary')
    .eq('opportunity_id', params.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    has_run: !!pi,
    generated_at: pi?.generated_at || null,
    summary: pi?.summary
      ? {
          total_documents: pi.summary.total_documents,
          drawings: pi.summary.drawings,
          specs: pi.summary.specs,
          tcb_sections: (pi.summary.tcb_sections || []).length,
          spec_section_index: (pi.summary.spec_section_index || []).length,
          readiness: pi.summary.readiness,
        }
      : null,
  });
}
