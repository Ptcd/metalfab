#!/usr/bin/env node
/**
 * fetch-buildingconnected.js - Scrapes public bid boards on BuildingConnected
 *
 * BuildingConnected (Autodesk) hosts public plan rooms/bid boards for GCs.
 * Project data is embedded as BC.publicPage JSON in the page HTML.
 * No login required for public bid boards.
 *
 * Currently scraping:
 *   - Corporate Contractors Inc. (CCI) — Beloit, WI (45 min from Racine)
 *     URL: app.buildingconnected.com/public/54f40ad670d2a30a00201edd
 *
 * More GCs can be added by appending their public board ID to GC_BOARDS.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { execSync } = require('child_process');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BC_BASE = 'https://app.buildingconnected.com/public';

// GC public bid boards: { id, name, shortName }
const GC_BOARDS = [
  {
    id: '54f40ad670d2a30a00201edd',
    name: 'Corporate Contractors Inc.',
    shortName: 'CCI',
    location: 'Beloit, WI',
  },
];

async function supabaseRequest(method, endpoint, body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text}`);
  }
  return res.json();
}

function curlFetch(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const html = execSync(
        `curl -s -L --connect-timeout 15 --max-time 30 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -H "Accept: text/html" "${url}"`,
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 45000 }
      );
      if (html && html.length > 500) return html;
      console.log(`  Attempt ${attempt}: short response (${html?.length || 0} chars) — retrying...`);
    } catch (e) {
      console.log(`  Attempt ${attempt} failed: ${e.message.slice(0, 80)}`);
    }
    if (attempt < retries) {
      execSync(`ping -n ${attempt * 2} 127.0.0.1 > nul`, { encoding: 'utf8', timeout: 10000 });
    }
  }
  return null;
}

function extractPublicPageData(html) {
  // BC.publicPage data is embedded as JSON in the page
  // Pattern: BC.publicPage = {...};
  const match = html.match(/BC\.publicPage\s*=\s*(\{[\s\S]*?\});\s*(?:BC\.|<\/script>)/);
  if (!match) {
    // Try alternate pattern
    const match2 = html.match(/publicPage['"]\s*:\s*(\{[\s\S]*?\})\s*[,}]\s*(?:<\/script>|;)/);
    if (match2) return JSON.parse(match2[1]);
    return null;
  }
  return JSON.parse(match[1]);
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(div|p|li|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function scrapeBoard(gc) {
  const url = `${BC_BASE}/${gc.id}`;
  console.log(`\n  📋 ${gc.name} (${gc.location})`);
  console.log(`     ${url}`);

  const html = curlFetch(url);
  if (!html) {
    console.log('     ❌ Failed to fetch page');
    return [];
  }

  let pageData;
  try {
    pageData = extractPublicPageData(html);
  } catch (e) {
    console.log(`     ❌ Failed to parse BC.publicPage: ${e.message}`);
    return [];
  }

  if (!pageData || !pageData.projects) {
    console.log('     ❌ No project data found in page');
    return [];
  }

  const projects = pageData.projects;
  console.log(`     Found ${projects.length} projects (total listed: ${pageData.totalProjects || '?'})`);

  const results = [];

  for (const proj of projects) {
    const name = (proj.name || '').trim();
    if (!name) continue;

    // Clean title — remove status tags like "- AWARDED GC", "- PENDING"
    let title = name.replace(/\s*[-–]\s*(AWARDED|PENDING|CLOSED|CANCELLED)\s*(GC)?$/i, '').trim();

    // Extract status from name
    let status = 'open';
    if (/AWARDED/i.test(name)) status = 'awarded';
    if (/PENDING/i.test(name)) status = 'pending';
    if (/CLOSED/i.test(name)) status = 'closed';

    const loc = proj.location || {};
    const city = loc.city || '';
    const state = loc.state || 'WI';
    const address = loc.complete || '';

    let bidDateISO = null;
    let bidDateStr = null;
    if (proj.dateBidsDue) {
      const d = new Date(proj.dateBidsDue);
      bidDateISO = d.toISOString().split('T')[0];
      bidDateStr = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
    }

    // Strip HTML from description
    const description = stripHtml(proj.description || '');

    results.push({
      projectId: proj._id,
      gcId: gc.id,
      gcName: gc.name,
      gcShort: gc.shortName,
      title,
      projectStatus: status,
      city,
      state,
      address,
      bidDate: bidDateStr,
      bidDateISO,
      description: description.substring(0, 2000),
      url: `${BC_BASE}/${gc.id}`,
      datePublished: proj.datePublished,
    });
  }

  return results;
}

async function scrape() {
  console.log('🏗️  Fetching BuildingConnected public bid boards...');

  let allProjects = [];

  for (const gc of GC_BOARDS) {
    const projects = await scrapeBoard(gc);
    allProjects = allProjects.concat(projects);
  }

  // Filter to open/listed projects only (skip awarded/closed)
  const biddable = allProjects.filter(p => p.projectStatus !== 'awarded' && p.projectStatus !== 'closed');
  console.log(`\n  ${allProjects.length} total projects, ${biddable.length} open for bidding\n`);

  if (biddable.length === 0) {
    console.log('ℹ️  No open bidding projects found.');
    return { source: 'buildingconnected', projectsFound: 0, imported: 0, skipped: 0, projects: [] };
  }

  let imported = 0;
  let skipped = 0;

  for (const proj of biddable) {
    console.log(`  📌 [${proj.gcShort}] ${proj.title} (${proj.projectStatus})`);
    console.log(`     Bid Date: ${proj.bidDate || 'unknown'} | ${proj.city}, ${proj.state}`);
    if (proj.description && proj.description.length > 30) {
      console.log(`     Scope: ${proj.description.substring(0, 120)}...`);
    }

    const noticeId = `BC-${proj.projectId}`;

    let descText = `GC: ${proj.gcName}`;
    if (proj.bidDate) descText += ` | Bid Date: ${proj.bidDate}`;
    if (proj.address) descText += `\nLocation: ${proj.address}`;
    if (proj.description) descText += `\n\n${proj.description}`;

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: `[${proj.gcShort}] ${proj.title}`,
        source: 'buildingconnected',
        status: 'new',
        source_url: proj.url,
        agency: proj.gcName,
        response_deadline: proj.bidDateISO,
        place_of_performance: proj.city ? `${proj.city}, ${proj.state}` : 'Wisconsin',
        description: descText,
        raw_data: JSON.stringify({
          ...proj,
          source_type: 'private_gc',
          scraped_at: new Date().toISOString(),
        }),
        posted_date: proj.datePublished ? proj.datePublished.split('T')[0] : new Date().toISOString().split('T')[0],
      });
      imported++;
    } catch (e) {
      if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('23505')) {
        skipped++;
        console.log(`     (already in DB)`);
      } else {
        console.error(`     Error: ${e.message}`);
      }
    }
  }

  const summary = {
    source: 'buildingconnected',
    timestamp: new Date().toISOString(),
    projectsFound: allProjects.length,
    biddable: biddable.length,
    imported,
    skipped,
    gcBoards: GC_BOARDS.map(g => g.name),
  };

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${biddable.length} biddable projects`);
  return summary;
}

scrape().then(result => {
  console.log(`\n✅ BuildingConnected fetch complete. ${result.biddable} biddable projects (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
