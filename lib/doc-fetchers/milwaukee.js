/**
 * City of Milwaukee doc fetcher.
 *
 * City Purchasing bid detail pages are public HTML with inline links to PDFs
 * (specifications, drawings, addenda). We fetch the source_url, parse links,
 * and return any that look like bid documents.
 */

const { execSync } = require('child_process');
const cheerio = require('cheerio');
const path = require('path');
const { categorizeFilename, sanitizeFilename } = require('../documents');

async function findCandidates(opp) {
  if (!opp.source_url) return { candidates: [], reason: 'no_source_url' };

  let html;
  try {
    html = execSync(
      `curl -s -L --connect-timeout 15 --max-time 30 -A "Mozilla/5.0" "${opp.source_url}"`,
      { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 45000 }
    );
  } catch (e) {
    return { candidates: [], reason: `fetch_failed:${e.message.slice(0, 60)}` };
  }
  if (!html || html.length < 200) return { candidates: [], reason: 'empty_response' };

  const $ = cheerio.load(html);
  const base = new URL(opp.source_url);
  const candidates = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/\.(pdf|docx?|xlsx?|zip)(\?|$)/i.test(href)) return;
    let absolute;
    try { absolute = new URL(href, base).href; } catch { return; }
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const linkText = $(el).text().trim();
    const nameFromUrl = path.basename(absolute.split('?')[0]);
    const filename = sanitizeFilename(linkText && linkText.length < 80 ? `${linkText}_${nameFromUrl}` : nameFromUrl);
    candidates.push({
      url: absolute,
      filename,
      category: categorizeFilename(filename + ' ' + linkText),
    });
  });

  return { candidates };
}

module.exports = { findCandidates };
