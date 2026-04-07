#!/usr/bin/env node
/**
 * fetch-cdsmith.js - Scrapes bidding projects from CD Smith Construction plan room
 *
 * CD Smith Construction (cdsmith.com) is a major Wisconsin GC based in Fond du Lac.
 * Their plan room at cdsmithplans.com lists projects open for subcontractor bidding.
 *
 * The homepage shows "Recent Projects Posted" with project names, bid dates, and links.
 * No login required for the listing (detail pages require login).
 *
 * Plan room powered by ReproConnect / Blueprint Solutions.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { execSync } = require('child_process');
const cheerio = require('cheerio');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BASE_URL = 'https://www.cdsmithplans.com';

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
        { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 45000 }
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

function parseProjects(html) {
  const $ = cheerio.load(html);
  const projects = [];

  // Find all project links in the "Recent Projects Posted" section
  // Project links follow pattern: /projects/{id}/details/{slug}
  $('a[href*="/projects/"]').each((_, el) => {
    const link = $(el);
    const href = link.attr('href') || '';
    const title = link.text().trim();

    // Match project URL pattern
    const match = href.match(/\/projects\/(\d+)\/details\/([\w-]+)/);
    if (!match || !title || title.length < 5) return;

    const projectId = match[1];
    const slug = match[2];

    // Find bid date - it should be in a sibling or nearby element
    // The pattern on the page is: project name link, then "Bids M/D/YY" text
    let bidDate = null;
    let bidDateISO = null;

    // Look at the parent and siblings for bid date
    const parent = link.parent();
    const parentText = parent.text();
    const nextText = link.next().text() || '';
    const surroundingText = parentText + ' ' + nextText;

    const dateMatch = surroundingText.match(/Bids?\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
    if (dateMatch) {
      const month = dateMatch[1].padStart(2, '0');
      const day = dateMatch[2].padStart(2, '0');
      let year = dateMatch[3];
      if (year.length === 2) year = '20' + year;
      bidDate = `${month}/${day}/${year}`;
      bidDateISO = `${year}-${month}-${day}`;
    }

    // Try to extract location from project name
    // Many CD Smith projects include city names (Sheboygan, Madison, De Pere, etc.)
    let city = '';
    const cityPatterns = [
      /Sheboygan/i, /Madison/i, /De Pere/i, /Oak Creek/i, /Sparta/i,
      /Freedom/i, /Kiel/i, /Fond du Lac/i, /Oshkosh/i, /Appleton/i,
      /Green Bay/i, /Milwaukee/i, /Waukesha/i, /Racine/i, /Kenosha/i,
    ];
    for (const pattern of cityPatterns) {
      const cityMatch = title.match(pattern);
      if (cityMatch) { city = cityMatch[0]; break; }
    }

    // Build URL — handle both absolute and relative hrefs
    const projectUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

    projects.push({
      projectId,
      slug,
      title,
      bidDate,
      bidDateISO,
      city,
      state: 'WI',
      url: projectUrl,
    });
  });

  return projects;
}

async function scrape() {
  console.log('🏗️  Fetching CD Smith Construction Plan Room (cdsmithplans.com)...');

  const html = curlFetch(BASE_URL);
  if (!html) {
    throw new Error('Failed to fetch CD Smith plan room page');
  }

  const projects = parseProjects(html);
  console.log(`  Found ${projects.length} bidding projects\n`);

  if (projects.length === 0) {
    console.log('ℹ️  No bidding projects found. CD Smith may have no open bids right now.');
    return { source: 'cdsmith', projectsFound: 0, imported: 0, skipped: 0, projects: [] };
  }

  let imported = 0;
  let skipped = 0;

  for (const proj of projects) {
    console.log(`  📌 [${proj.projectId}] ${proj.title}`);
    console.log(`     Bid Date: ${proj.bidDate || 'unknown'} | City: ${proj.city || 'WI'}`);

    const noticeId = `CDSMITH-${proj.projectId}`;

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: `[CD Smith] ${proj.title}`,
        source: 'cdsmith',
        status: 'new',
        source_url: proj.url,
        agency: 'CD Smith Construction',
        response_deadline: proj.bidDateISO,
        place_of_performance: proj.city ? `${proj.city}, WI` : 'Wisconsin',
        description: `GC: CD Smith Construction | Bid Date: ${proj.bidDate || 'TBD'}\nContact: bids@cdsmith.com | Phone: 920.924.2900`,
        raw_data: JSON.stringify({
          ...proj,
          gc: 'CD Smith Construction',
          source_type: 'private_gc',
          scraped_at: new Date().toISOString(),
        }),
        posted_date: new Date().toISOString().split('T')[0],
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
    source: 'cdsmith',
    timestamp: new Date().toISOString(),
    projectsFound: projects.length,
    imported,
    skipped,
    projects: projects.map(p => ({
      projectId: p.projectId,
      title: p.title,
      bidDate: p.bidDate,
      city: p.city,
      url: p.url,
    }))
  };

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${projects.length} projects`);

  console.log('\n__CDSMITH_JSON__');
  console.log(JSON.stringify(summary, null, 2));
  console.log('__CDSMITH_JSON_END__');

  return summary;
}

scrape().then(result => {
  console.log(`\n✅ CD Smith fetch complete. Found ${result.projectsFound} projects (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
