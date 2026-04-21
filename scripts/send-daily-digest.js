#!/usr/bin/env node
/**
 * send-daily-digest.js — emails Gohar the opportunities flagged as
 * qa_qualified in the last 24 hours, CC'ing Colin.
 *
 * Uses Brevo (formerly Sendinblue) transactional API.
 *
 * Env required:
 *   BREVO_API_KEY         — Brevo transactional API key
 *   BREVO_SENDER_EMAIL    — verified sender address (default: bids@tcbmetalworks.com)
 *   ESTIMATOR_EMAIL       — Gohar, primary recipient (falls back to scoring_config.estimator_email)
 *   OWNER_EMAIL           — Colin, CC (falls back to scoring_config.owner_email)
 *   CRM_PUBLIC_URL        — base URL for opportunity links (default: https://tcbmetalworks.vercel.app)
 *
 * Brevo practical email size cap is ~10 MB total; we cap attachments at 10 MB
 * even though the spec references 25 MB, to avoid provider rejection.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { downloadStorageFile } = require('../lib/documents');
const { startRun, addStep, addError, finishRun } = require('../lib/system-runs');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'bids@tcbmetalworks.com';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'TCB Metalworks Bid Pipeline';
const CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL || 'https://tcbmetalworks.vercel.app';
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function loadConfig() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/scoring_config?select=*&limit=1`,
    { headers: headers() }
  );
  const [cfg] = await res.json();
  return cfg || {};
}

async function loadQualified() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  // Skip past-deadline opps — no point emailing Gohar something he can't bid on
  const deadlineFilter = `or=(response_deadline.is.null,response_deadline.gte.${nowIso})`;
  const url = `${SUPABASE_URL}/rest/v1/opportunities?status=eq.qa_qualified&updated_at=gte.${since}&${deadlineFilter}&select=*&order=updated_at.desc`;
  const res = await fetch(url, { headers: headers() });
  return res.json();
}

async function countAwaitingQa() {
  const url = `${SUPABASE_URL}/rest/v1/opportunities?status=eq.awaiting_qa&select=id`;
  const res = await fetch(url, { headers: { ...headers(), Prefer: 'count=exact' } });
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function fmtDollars(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function renderOpp(opp) {
  const report = opp.qa_report || (opp.raw_data && opp.raw_data.qa_report) || {};
  const risks = (report.risk_flags || []).map(esc).join(', ') || 'none';
  const val = report.steel_metals_estimated_value_usd;
  return `
  <div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;background:#fff;">
    <h3 style="margin:0 0 4px;font-size:16px;color:#0f172a;">
      <a href="${CRM_PUBLIC_URL}/opportunity/${opp.id}" style="color:#2563eb;text-decoration:none;">
        ${esc(opp.title)}
      </a>
    </h3>
    <p style="margin:0 0 8px;font-size:13px;color:#64748b;">
      ${esc(opp.agency || 'Unknown agency')} · Due ${fmtDate(opp.response_deadline)}
    </p>
    <p style="margin:0 0 8px;font-size:13px;">
      <strong>Metals value (est):</strong> ${val != null ? fmtDollars(val) : '—'} ·
      <strong>Bid range:</strong> ${fmtDollars(opp.dollar_min)} – ${fmtDollars(opp.dollar_max)}
    </p>
    ${report.scope_summary ? `<p style="margin:8px 0;font-size:14px;line-height:1.5;color:#334155;">${esc(report.scope_summary)}</p>` : ''}
    <p style="margin:4px 0;font-size:13px;color:#7c2d12;"><strong>Risk flags:</strong> ${risks}</p>
    ${report.recommendation_reasoning ? `<p style="margin:4px 0;font-size:13px;color:#475569;font-style:italic;">"${esc(report.recommendation_reasoning)}"</p>` : ''}
  </div>`;
}

function renderHtml({ qualified, awaitingCount, today }) {
  const oppsHtml = qualified.map(renderOpp).join('\n');
  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#0f172a;">
  <div style="max-width:680px;margin:0 auto;">
    <h1 style="font-size:22px;margin:0 0 4px;">TCB Bid Digest — ${today}</h1>
    <p style="color:#64748b;margin:0 0 24px;font-size:14px;">
      ${qualified.length} qualified bid${qualified.length === 1 ? '' : 's'} · ${awaitingCount} still in QA queue
    </p>
    ${qualified.length === 0
      ? '<p style="background:#fef3c7;padding:16px;border-radius:8px;">No new qualified bids today. The pipeline is running.</p>'
      : oppsHtml}
    <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;">
    <p style="font-size:12px;color:#94a3b8;">
      Open the CRM: <a href="${CRM_PUBLIC_URL}/today">${CRM_PUBLIC_URL}/today</a>
    </p>
  </div>
</body></html>`;
}

async function collectAttachments(qualified) {
  const out = [];
  let totalBytes = 0;
  const tmpDir = require('os').tmpdir();
  for (const opp of qualified) {
    const docs = (opp.documents || [])
      .slice()
      .sort((a, b) => {
        const rank = { specification: 1, drawing: 2, addendum: 3, general: 4, form: 5 };
        return (rank[a.category] || 9) - (rank[b.category] || 9);
      })
      .slice(0, 3);
    for (const d of docs) {
      if (totalBytes + (d.file_size || 0) > MAX_ATTACHMENT_BYTES) break;
      const local = path.join(tmpDir, `digest-${opp.id}-${d.filename}`);
      try {
        const bytes = await downloadStorageFile(d.storage_path, local);
        if (totalBytes + bytes > MAX_ATTACHMENT_BYTES) {
          fs.unlinkSync(local);
          break;
        }
        const b64 = fs.readFileSync(local).toString('base64');
        fs.unlinkSync(local);
        out.push({ name: `${opp.id.slice(0, 8)}_${d.filename}`, content: b64 });
        totalBytes += bytes;
      } catch {
        // skip; keep going
      }
    }
  }
  return { attachments: out, totalBytes };
}

async function sendEmail({ to, cc, subject, html, attachments }) {
  const body = {
    sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
    to: to.map((email) => ({ email })),
    cc: cc.length ? cc.map((email) => ({ email })) : undefined,
    subject,
    htmlContent: html,
  };
  if (attachments && attachments.length > 0) body.attachment = attachments;

  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function runDigest() {
  if (!BREVO_API_KEY) {
    return { ok: false, skipped: true, reason: 'BREVO_API_KEY not set' };
  }
  const run = await startRun('digest');

  const cfg = await loadConfig();
  const to = process.env.ESTIMATOR_EMAIL || cfg.estimator_email;
  const ccAddr = process.env.OWNER_EMAIL || cfg.owner_email;
  if (!to) {
    await addError(run, 'config', 'no estimator email');
    await finishRun(run, { status: 'failed' });
    return { ok: false, error: 'no estimator email configured' };
  }

  const qualified = await loadQualified();
  const awaitingCount = await countAwaitingQa();
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const { attachments, totalBytes } = qualified.length > 0
    ? await collectAttachments(qualified)
    : { attachments: [], totalBytes: 0 };

  const subject = qualified.length === 0
    ? `TCB Bid Digest — no new qualified bids (${awaitingCount} in queue)`
    : `TCB Bid Digest — ${qualified.length} qualified bid${qualified.length === 1 ? '' : 's'}`;

  const html = renderHtml({ qualified, awaitingCount, today });
  try {
    const result = await sendEmail({
      to: [to],
      cc: ccAddr ? [ccAddr] : [],
      subject,
      html,
      attachments,
    });
    await addStep(run, 'sent', {
      qualified: qualified.length,
      awaiting: awaitingCount,
      attachments: attachments.length,
      attachment_bytes: totalBytes,
      message_id: result.messageId,
    });
    await finishRun(run, {
      status: 'success',
      opportunities_processed: qualified.length,
    });
    return {
      ok: true,
      qualified: qualified.length,
      awaiting: awaitingCount,
      attachments: attachments.length,
      attachment_bytes: totalBytes,
      message_id: result.messageId,
    };
  } catch (e) {
    await addError(run, 'send', e);
    await finishRun(run, { status: 'failed' });
    await sendOwnerAlert(ccAddr, 'Digest send failed', e).catch(() => {});
    return { ok: false, error: e.message };
  }
}

async function sendOwnerAlert(to, subject, error) {
  if (!to || !BREVO_API_KEY) return;
  const html = `<pre style="font-family:monospace;font-size:12px;">${esc(error?.stack || error?.message || String(error))}</pre>`;
  await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      subject: `[TCB Pipeline] ${subject}`,
      htmlContent: html,
    }),
  });
}

module.exports = { runDigest };

if (require.main === module) {
  runDigest()
    .then((r) => {
      if (r.ok) {
        console.log(`✅ Digest sent: ${r.qualified} qualified, ${r.attachments} attachments (${Math.round((r.attachment_bytes || 0) / 1024)} KB)`);
      } else if (r.skipped) {
        console.log(`⚠️  Skipped: ${r.reason}`);
      } else {
        console.error('Send failed:', r.error);
        process.exit(1);
      }
    })
    .catch((e) => {
      console.error('Fatal:', e);
      process.exit(1);
    });
}
