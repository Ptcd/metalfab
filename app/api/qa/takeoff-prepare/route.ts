import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/qa/takeoff-prepare?opp=<id>
 * Emails Colin the three commands to run locally for takeoff QA on this opp:
 *   node scripts/takeoff-qa-prepare.js --opp=<id>
 *   open Claude Code, run scripts/takeoff-qa.md
 *   node scripts/takeoff-qa-commit.js
 */
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const oppId = new URL(request.url).searchParams.get('opp');
  if (!oppId) return NextResponse.json({ error: 'opp query param required' }, { status: 400 });

  const supabase = createServiceClient();
  const { data: opp } = await supabase
    .from('opportunities')
    .select('id, title, documents, qa_report')
    .eq('id', oppId)
    .single();
  if (!opp) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const hasTakeoff = Array.isArray(opp.documents) && opp.documents.some((d: { category: string }) => d.category === 'takeoff');
  if (!hasTakeoff) {
    return NextResponse.json({
      ok: false,
      error: 'No takeoff document on this opportunity. Upload a takeoff (category: Takeoff) first.',
    }, { status: 400 });
  }
  if (!opp.qa_report) {
    return NextResponse.json({
      ok: false,
      error: 'No QA report on this opportunity yet. Run QA analysis first.',
    }, { status: 400 });
  }

  const brevoKey = process.env.BREVO_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;
  const sender = process.env.BREVO_SENDER_EMAIL || 'bids@quoteautomator.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'TCB Metalworks';

  if (!brevoKey || !ownerEmail) {
    return NextResponse.json({
      ok: false,
      error: 'BREVO_API_KEY or OWNER_EMAIL not set — cannot send instructions',
    }, { status: 400 });
  }

  const html = `
    <h2>Takeoff QA requested for ${opp.title}</h2>
    <p>A VA / estimator asked for a takeoff QA on this opportunity. On your local machine:</p>
    <pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:13px;line-height:1.6;">
node scripts/takeoff-qa-prepare.js --opp=${oppId}
# open Claude Code, tell it to run scripts/takeoff-qa.md
node scripts/takeoff-qa-commit.js
    </pre>
    <p>Claude Code will compare Gohar's takeoff against the QA report's
    identified_members list and flag missing items, quantity mismatches,
    and finish spec issues.</p>
    <p><a href="https://quoteautomator.com/opportunity/${oppId}">Open in CRM →</a></p>
  `;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: senderName, email: sender },
        to: [{ email: ownerEmail }],
        subject: `[Bid Pipeline] Takeoff QA requested: ${opp.title}`,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo ${res.status}: ${text.slice(0, 200)}`);
    }
    return NextResponse.json({
      ok: true,
      message: `Emailed ${ownerEmail} with takeoff-QA instructions.`,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
