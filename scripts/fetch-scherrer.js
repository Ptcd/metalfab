#!/usr/bin/env node
/**
 * fetch-scherrer.js - Scrapes bidding projects from Scherrer Construction plan room
 *
 * Scherrer Construction (scherrerconstruction.com) is a Wisconsin GC
 * based in Burlington, WI (15 min from Racine).
 *
 * Their plan room uses PipelineSuite (PreconSuite). The open projects
 * widget loads from projects.pipelinesuite.com as an embeddable iframe.
 * We fetch the iframe URL directly — no login required.
 *
 * Each project has: name, bid date, location, estimator contact info.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { execSync } = require('child_process');
const cheerio = require('cheerio');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// PipelineSuite open projects widget URL for Scherrer (client ID 509)
const WIDGET_URL = 'https://projects.pipelinesuite.com/ehProjects/dspOpenProjects/id/509/s/vFCmkC0qKjFYPUjJhKknVocZgPvsBDf2nGrLNAZww/bg/FFFFFF/pb/FFFFFF/h/F5F5F5/ht/333333/b/DDDDDD/t/333333';

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
      if (html && html.length > 200) return html;
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

  // PipelineSuite renders projects as panels with links containing "projectID"
  // Each project panel has: project name + address link, bid due date text,
  // and a contact table below

  // Find all project links (href contains "projectID")
  const projectLinks = $('a[href*="projectID"]');

  if (projectLinks.length === 0) {
    // Fallback: try parsing any visible project-like content
    // Look for text patterns like "Bid Due Date:" and project names
    const bodyText = $('body').text();
    console.log(`  No projectID links found. Body length: ${bodyText.length}`);

    // Try finding projects by bid date pattern
    const panels = $('.panel, .card, [class*="project"]');
    panels.each((_, panel) => {
      const panelText = $(panel).text();
      const bidMatch = panelText.match(/Bid Due Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      if (bidMatch) {
        console.log(`  Found panel with bid date: ${bidMatch[1]}`);
      }
    });

    return projects;
  }

  projectLinks.each((_, el) => {
    const link = $(el);
    const href = link.attr('href') || '';

    // Extract project ID from href
    const idMatch = href.match(/projectID\/(\d+)/);
    const projectId = idMatch ? idMatch[1] : null;

    // The link text is the project name + address
    const linkText = link.text().trim();
    if (!linkText || linkText.length < 5) return;

    // Parse project name and address from link text
    // Pattern: "Project Name - Address City, ST ZIP"
    let title = linkText;
    let address = '';
    let city = '';
    let state = 'WI';
    let zip = '';

    // Try to extract address: look for state abbreviation pattern
    const addrMatch = linkText.match(/^(.+?)\s*[-–]\s*(.+?,\s*([A-Z]{2})\s*(\d{5})?)$/);
    if (addrMatch) {
      title = addrMatch[1].trim();
      address = addrMatch[2].trim();
      state = addrMatch[3] || 'WI';
      zip = addrMatch[4] || '';
      // Extract city from address
      const cityMatch = address.match(/([A-Za-z\s]+),\s*[A-Z]{2}/);
      if (cityMatch) city = cityMatch[1].trim();
    } else {
      // Try simpler split
      const parts = linkText.split(/\s*[-–]\s*/);
      if (parts.length >= 2) {
        title = parts[0].trim();
        address = parts.slice(1).join(' - ').trim();
        // Extract city/state/zip from address
        const csz = address.match(/([A-Za-z\s]+),?\s*([A-Z]{2})?\s*(\d{5})?/);
        if (csz) {
          city = csz[1]?.trim() || '';
          state = csz[2] || 'WI';
          zip = csz[3] || '';
        }
      }
    }

    // Find bid due date — look in surrounding content
    const panel = link.closest('.panel, .card, div').parent();
    const panelText = panel ? panel.text() : '';
    let bidDate = null;
    let bidDateISO = null;

    const dateMatch = panelText.match(/Bid Due Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*([\d:]+\s*[AP]M)?/i);
    if (dateMatch) {
      const month = dateMatch[1].padStart(2, '0');
      const day = dateMatch[2].padStart(2, '0');
      let year = dateMatch[3];
      if (year.length === 2) year = '20' + year;
      const time = dateMatch[4] || '';
      bidDate = `${month}/${day}/${year}${time ? ' ' + time : ''}`;
      bidDateISO = `${year}-${month}-${day}`;
    }

    // Find contact info from nearby table
    let contact = null;
    const contactTable = panel ? panel.find('table').first() : null;
    if (contactTable && contactTable.length) {
      const rows = contactTable.find('tr');
      rows.each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 3) {
          contact = {
            name: $(cells[0]).text().trim(),
            type: $(cells[1]).text().trim(),
            phone: $(cells[2]).text().trim(),
            email: cells.length >= 5 ? $(cells[4]).text().trim() : '',
          };
        }
      });
    }

    projects.push({
      projectId: projectId || `scherrer-${projects.length}`,
      title,
      address,
      city,
      state,
      zip,
      bidDate,
      bidDateISO,
      contact,
      url: `https://scherrerconstruction.com/bidding`,
    });
  });

  return projects;
}

async function scrape() {
  console.log('🏗️  Fetching Scherrer Construction Plan Room (PipelineSuite)...');

  const html = curlFetch(WIDGET_URL);
  if (!html) {
    throw new Error('Failed to fetch Scherrer PipelineSuite widget');
  }
  console.log(`  Widget HTML: ${html.length} chars`);

  const projects = parseProjects(html);
  console.log(`  Found ${projects.length} bidding projects\n`);

  if (projects.length === 0) {
    console.log('ℹ️  No bidding projects found. Scherrer may have no open bids right now.');
    return { source: 'scherrer', projectsFound: 0, imported: 0, skipped: 0, projects: [] };
  }

  let imported = 0;
  let skipped = 0;

  for (const proj of projects) {
    console.log(`  📌 [${proj.projectId}] ${proj.title}`);
    console.log(`     Bid Date: ${proj.bidDate || 'unknown'} | Location: ${proj.city || proj.address}, ${proj.state}`);
    if (proj.contact) console.log(`     Contact: ${proj.contact.name} (${proj.contact.type}) ${proj.contact.email}`);

    const noticeId = `SCHERRER-${proj.projectId}`;

    let descText = `GC: Scherrer Construction (Burlington, WI)`;
    if (proj.bidDate) descText += ` | Bid Date: ${proj.bidDate}`;
    if (proj.address) descText += `\nLocation: ${proj.address}`;
    if (proj.contact) {
      descText += `\nContact: ${proj.contact.name} (${proj.contact.type})`;
      if (proj.contact.phone) descText += ` | ${proj.contact.phone}`;
      if (proj.contact.email) descText += ` | ${proj.contact.email}`;
    }

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: `[Scherrer] ${proj.title}`,
        source: 'scherrer',
        status: 'new',
        source_url: proj.url,
        agency: 'Scherrer Construction',
        response_deadline: proj.bidDateISO,
        place_of_performance: proj.city ? `${proj.city}, ${proj.state}` : (proj.address || 'Wisconsin'),
        description: descText,
        raw_data: JSON.stringify({
          ...proj,
          gc: 'Scherrer Construction',
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
    source: 'scherrer',
    timestamp: new Date().toISOString(),
    projectsFound: projects.length,
    imported,
    skipped,
    projects: projects.map(p => ({
      projectId: p.projectId,
      title: p.title,
      bidDate: p.bidDate,
      city: p.city,
      address: p.address,
      url: p.url,
    }))
  };

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${projects.length} projects`);
  return summary;
}

scrape().then(result => {
  console.log(`\n✅ Scherrer fetch complete. Found ${result.projectsFound} projects (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
