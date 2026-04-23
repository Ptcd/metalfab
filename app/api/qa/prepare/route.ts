import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/db/supabase';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Staged QA kick-off. We can't run Claude Code from a Vercel serverless
 * function — it needs the owner's OAuth session and local filesystem. So
 * this endpoint just:
 *   1. Counts how many opps are in awaiting_qa.
 *   2. Emails Colin ("owner") telling him to run the local staging script
 *      (`node scripts/qa-prepare.js`), then kick off Claude Code.
 *   3. Logs the notification as a system_run so the /activity page records it.
 *
 * The VA clicks this button on /today; Colin gets the email; Colin runs
 * Claude Code on his laptop.
 */
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { count } = await supabase
    .from('opportunities')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'awaiting_qa');

  const awaitingCount = count ?? 0;

  // Log a system_run entry
  const { data: run } = await supabase
    .from('system_runs')
    .insert({
      run_type: 'manual',
      status: 'success',
      notes: `VA-triggered QA notification: ${awaitingCount} opps awaiting`,
      opportunities_processed: awaitingCount,
      ended_at: new Date().toISOString(),
    })
    .select()
    .single();

  // Send the email
  const brevoKey = process.env.BREVO_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;
  const sender = process.env.BREVO_SENDER_EMAIL || 'bids@quoteautomator.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'TCB Metalworks Bid Pipeline';

  if (!brevoKey || !ownerEmail) {
    return NextResponse.json({
      ok: false,
      awaiting: awaitingCount,
      error: 'BREVO_API_KEY or OWNER_EMAIL not set — cannot send notification',
    }, { status: 400 });
  }

  if (awaitingCount === 0) {
    return NextResponse.json({
      ok: true,
      awaiting: 0,
      sent: false,
      message: 'No opportunities are awaiting QA. Nothing to do.',
    });
  }

  const html = `
    <h2>Bid Pipeline — ${awaitingCount} opportunit${awaitingCount === 1 ? 'y' : 'ies'} ready for QA</h2>
    <p>A VA just clicked "Run QA Now" on <a href="https://quoteautomator.com/today">quoteautomator.com</a>.</p>
    <p><strong>On your local machine:</strong></p>
    <pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:13px;">
node scripts/qa-prepare.js        <em># pulls ${awaitingCount} opps locally</em>
# open Claude Code, tell it to run scripts/qa-analyze.md
node scripts/qa-commit.js         <em># pushes results back, purges rejects</em>
    </pre>
    <p>Once qa-commit.js finishes, qualified opps land in the afternoon digest.</p>
    <p style="color:#64748b;font-size:12px;">Triggered at ${new Date().toISOString()}</p>
  `;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName, email: sender },
        to: [{ email: ownerEmail }],
        subject: `[Bid Pipeline] ${awaitingCount} opportunit${awaitingCount === 1 ? 'y' : 'ies'} ready for Claude Code QA`,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo ${res.status}: ${text.slice(0, 200)}`);
    }
    return NextResponse.json({
      ok: true,
      awaiting: awaitingCount,
      sent: true,
      message: `Emailed ${ownerEmail} with instructions.`,
      run_id: run?.id,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      awaiting: awaitingCount,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
