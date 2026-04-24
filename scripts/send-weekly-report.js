#!/usr/bin/env node
/**
 * send-weekly-report.js — Friday afternoon pipeline snapshot to Colin.
 *
 * Counts opps by stage, bids submitted this week, new this week,
 * qualified this week, won/lost this week, overdue reminders, and
 * top 5 ready-for-estimator opps. Sends via Brevo to OWNER_EMAIL.
 *
 * Runs as part of the afternoon cron chain, but only actually sends
 * on Fridays (US Central). Skips otherwise so we don't spam Colin daily.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { startRun, addStep, addError, finishRun } = require('../lib/system-runs');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'bids@quoteautomator.com';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'TCB Metalworks Bid Pipeline';
const CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL || 'https://quoteautomator.com';

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function isFridayCentral(date = new Date()) {
  // `toLocaleString` with tz returns a string parseable back to Date, but
  // we just need the weekday in US/Central.
  const day = date.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short' });
  return day === 'Fri';
}

function fmtDollars(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

async function countByStatus() {
  const statuses = [
    'new', 'reviewing', 'awaiting_qa', 'qa_qualified', 'qa_rejected',
    'bidding', 'won', 'lost', 'passed',
  ];
  const out = {};
  for (const s of statuses) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/opportunities?status=eq.${s}&select=id`,
      { headers: { ...headers(), Prefer: 'count=exact' } }
    );
    const range = res.headers.get('content-range') || '';
    const m = range.match(/\/(\d+)/);
    out[s] = m ? parseInt(m[1], 10) : 0;
  }
  return out;
}

async function rangeCount(table, statusFilter, sinceIso) {
  // `statusFilter` is an already-formatted `status=eq.X` or similar
  const url = `${SUPABASE_URL}/rest/v1/${table}?${statusFilter}&updated_at=gte.${sinceIso}&select=id`;
  const res = await fetch(url, { headers: { ...headers(), Prefer: 'count=exact' } });
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function bidsThisWeek(sinceIso) {
  const url = `${SUPABASE_URL}/rest/v1/bid_submissions?submitted_at=gte.${sinceIso}&select=id,amount_usd,opportunity_id`;
  const res = await fetch(url, { headers: { ...headers(), Prefer: 'count=exact' } });
  const arr = await res.json();
  const total = Array.isArray(arr) ? arr.reduce((s, r) => s + (Number(r.amount_usd) || 0), 0) : 0;
  return { count: Array.isArray(arr) ? arr.length : 0, total };
}

async function topReady() {
  const url = `${SUPABASE_URL}/rest/v1/opportunities?status=eq.qa_qualified&select=id,title,agency,response_deadline,qa_report&order=updated_at.desc&limit=5`;
  const res = await fetch(url, { headers: headers() });
  return res.json();
}

async function overdueReminders() {
  const nowIso = new Date().toISOString();
  const url = `${SUPABASE_URL}/rest/v1/reminders?completed_at=is.null&due_at=lt.${nowIso}&select=id,subject,due_at,opportunity_id&order=due_at.asc&limit=10`;
  const res = await fetch(url, { headers: headers() });
  return res.json();
}

function renderHtml({ counts, weekly, ready, overdue }) {
  const totalActive = counts.reviewing + counts.awaiting_qa + counts.qa_qualified + counts.bidding;
  const readyRows = (ready || [])
    .map((r) => {
      const qa = r.qa_report || {};
      const dueStr = r.response_deadline
        ? new Date(r.response_deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;">
            <a href="${CRM_PUBLIC_URL}/opportunity/${r.id}" style="color:#2563eb;text-decoration:none;font-weight:500;">${esc(r.title)}</a><br/>
            <span style="color:#64748b;font-size:12px;">${esc(r.agency || '')}</span>
          </td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px;">${dueStr}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px;">${qa.steel_metals_estimated_value_usd != null ? fmtDollars(qa.steel_metals_estimated_value_usd) : '—'}</td>
        </tr>`;
    })
    .join('');

  const overdueRows = (overdue || [])
    .map((r) => {
      const days = Math.floor((Date.now() - new Date(r.due_at).getTime()) / 86400000);
      const href = r.opportunity_id ? `${CRM_PUBLIC_URL}/opportunity/${r.opportunity_id}` : `${CRM_PUBLIC_URL}/today`;
      return `<li><a href="${href}" style="color:#b91c1c;">${esc(r.subject)}</a> — <span style="color:#94a3b8;font-size:12px;">${days} day${days === 1 ? '' : 's'} overdue</span></li>`;
    })
    .join('');

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#0f172a;">
  <div style="max-width:720px;margin:0 auto;">
    <h1 style="font-size:22px;margin:0 0 4px;">TCB Weekly Pipeline Report</h1>
    <p style="color:#64748b;margin:0 0 24px;font-size:14px;">
      ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })}
    </p>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
      <h2 style="font-size:16px;margin:0 0 8px;">This week's activity</h2>
      <ul style="font-size:14px;line-height:1.6;margin:0;padding-left:20px;">
        <li><strong>${weekly.bidsCount}</strong> bid${weekly.bidsCount === 1 ? '' : 's'} submitted (${fmtDollars(weekly.bidsTotal)} total)</li>
        <li><strong>${weekly.newOpps}</strong> new opportunities scraped</li>
        <li><strong>${weekly.qualifiedOpps}</strong> moved to Ready for Estimator</li>
        <li><strong>${weekly.wonOpps}</strong> won · <strong>${weekly.lostOpps}</strong> lost</li>
      </ul>
    </div>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
      <h2 style="font-size:16px;margin:0 0 8px;">Pipeline right now</h2>
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:4px 8px;color:#475569;">Active (reviewing → bidding)</td><td style="padding:4px 8px;text-align:right;"><strong>${totalActive}</strong></td></tr>
        <tr><td style="padding:4px 8px;color:#475569;">Inbox — unscreened</td><td style="padding:4px 8px;text-align:right;">${counts.new}</td></tr>
        <tr><td style="padding:4px 8px;color:#475569;">Awaiting AI analysis</td><td style="padding:4px 8px;text-align:right;">${counts.awaiting_qa}</td></tr>
        <tr><td style="padding:4px 8px;color:#475569;">Ready for estimator</td><td style="padding:4px 8px;text-align:right;"><strong>${counts.qa_qualified}</strong></td></tr>
        <tr><td style="padding:4px 8px;color:#475569;">Bidding</td><td style="padding:4px 8px;text-align:right;">${counts.bidding}</td></tr>
        <tr><td style="padding:4px 8px;color:#475569;">Won / Lost (all-time)</td><td style="padding:4px 8px;text-align:right;">${counts.won} / ${counts.lost}</td></tr>
      </table>
    </div>

    ${readyRows ? `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
      <h2 style="font-size:16px;margin:0 0 8px;">Top Ready-for-Estimator</h2>
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        <thead>
          <tr style="color:#64748b;text-align:left;">
            <th style="padding:8px;border-bottom:1px solid #e2e8f0;">Project</th>
            <th style="padding:8px;border-bottom:1px solid #e2e8f0;">Due</th>
            <th style="padding:8px;border-bottom:1px solid #e2e8f0;">Metals est.</th>
          </tr>
        </thead>
        <tbody>${readyRows}</tbody>
      </table>
    </div>` : ''}

    ${overdueRows ? `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:16px;">
      <h2 style="font-size:16px;margin:0 0 8px;color:#991b1b;">Overdue reminders</h2>
      <ul style="font-size:14px;line-height:1.6;margin:0;padding-left:20px;">
        ${overdueRows}
      </ul>
    </div>` : ''}

    <p style="font-size:12px;color:#94a3b8;">
      Full pipeline: <a href="${CRM_PUBLIC_URL}/today">${CRM_PUBLIC_URL}/today</a>
    </p>
  </div>
</body></html>`;
}

async function run({ force = false } = {}) {
  if (!force && !isFridayCentral()) {
    return { ok: true, skipped: true, reason: 'not Friday in US Central' };
  }
  if (!BREVO_KEY) return { ok: false, error: 'BREVO_API_KEY not set' };
  const runRow = await startRun('manual', 'weekly-report');

  try {
    // Week window: 7 days ago through now
    const sinceIso = new Date(Date.now() - 7 * 86400000).toISOString();

    const [counts, bidsData, readyList, overdueList] = await Promise.all([
      countByStatus(),
      bidsThisWeek(sinceIso),
      topReady(),
      overdueReminders(),
    ]);

    const [newOpps, qualifiedOpps, wonOpps, lostOpps] = await Promise.all([
      rangeCount('opportunities', 'status=eq.new', sinceIso),
      rangeCount('opportunities', 'status=eq.qa_qualified', sinceIso),
      rangeCount('opportunities', 'status=eq.won', sinceIso),
      rangeCount('opportunities', 'status=eq.lost', sinceIso),
    ]);

    const weekly = {
      bidsCount: bidsData.count,
      bidsTotal: bidsData.total,
      newOpps, qualifiedOpps, wonOpps, lostOpps,
    };

    const ownerEmail = process.env.OWNER_EMAIL;
    if (!ownerEmail) {
      await addError(runRow, 'config', 'OWNER_EMAIL not set');
      await finishRun(runRow, { status: 'failed' });
      return { ok: false, error: 'OWNER_EMAIL not set' };
    }

    const html = renderHtml({ counts, weekly, ready: readyList, overdue: overdueList });
    const subject = `TCB Weekly — ${weekly.bidsCount} bid${weekly.bidsCount === 1 ? '' : 's'} out, ${counts.qa_qualified} ready`;

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email: ownerEmail }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      await addError(runRow, 'brevo', text.slice(0, 200));
      await finishRun(runRow, { status: 'failed' });
      return { ok: false, error: `Brevo ${res.status}` };
    }

    await addStep(runRow, 'sent', weekly);
    await finishRun(runRow, {
      status: 'success',
      notes: `Weekly report: ${weekly.bidsCount} bids, ${counts.qa_qualified} ready, ${overdueList.length} overdue`,
    });
    return { ok: true, sent: true, weekly, counts };
  } catch (e) {
    await addError(runRow, 'fatal', e.message);
    await finishRun(runRow, { status: 'failed' });
    return { ok: false, error: e.message };
  }
}

module.exports = { runWeeklyReport: run };
if (require.main === module) {
  const force = process.argv.includes('--force');
  run({ force }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
  });
}
