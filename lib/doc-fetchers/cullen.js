/**
 * JP Cullen doc fetcher.
 *
 * Uses the Pantera Tools authenticated API (same auth flow as fetch-cullen.js).
 * Project detail includes an `attachments` array with download URLs.
 *
 * Fallback: if login fails, flag auth_required.
 */

const { categorizeFilename, sanitizeFilename } = require('../documents');

const API_URL = 'https://api.tm.panteratools.com';
const CULLEN_USER = process.env.CULLEN_USER || 'tcbmetalworks@aol.com';
const CULLEN_PASS = process.env.CULLEN_PASS || 'Steelbid123!';

let _cachedToken = null;
async function _getToken() {
  if (_cachedToken) return _cachedToken;
  if (!CULLEN_PASS) return null;
  const url = `https://api-v2.panteratools.com/token?username=${encodeURIComponent(CULLEN_USER)}&password=${encodeURIComponent(CULLEN_PASS)}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const token = data.accessToken || data.access_token || data.token;
  if (!token) return null;
  // activate session
  await fetch(`${API_URL}/token/signin`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
  _cachedToken = token;
  return token;
}

async function findCandidates(opp) {
  const token = await _getToken();
  if (!token) return { authRequired: true, candidates: [], reason: 'no_cullen_credentials' };

  const raw = _asObject(opp.raw_data);
  const projectId = raw.projectId || raw.rowId || (opp.sam_notice_id || '').replace(/^CULLEN-/, '');
  if (!projectId) return { candidates: [], reason: 'no_project_id' };

  // Fetch project detail which typically exposes attachments
  const detailRes = await fetch(`${API_URL}/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!detailRes.ok) {
    return { candidates: [], reason: `detail_${detailRes.status}` };
  }
  const detail = await detailRes.json();
  const attachments = Array.isArray(detail.attachments) ? detail.attachments
    : Array.isArray(detail.files) ? detail.files
    : [];

  const candidates = attachments.map((att) => {
    const name = att.name || att.fileName || att.filename || 'document.pdf';
    const url = att.url || att.downloadUrl || att.link;
    if (!url) return null;
    const filename = sanitizeFilename(name);
    return { url, filename, category: categorizeFilename(filename) };
  }).filter(Boolean);

  return { candidates, bearerToken: token };
}

function _asObject(x) {
  if (!x) return {};
  if (typeof x === 'string') { try { return JSON.parse(x); } catch { return {}; } }
  return x;
}

module.exports = { findCandidates };
