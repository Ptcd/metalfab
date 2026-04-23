#!/usr/bin/env node
/**
 * fetch-racine-county.js - Scrapes public bids from Racine County
 * No login needed — public HTML table at racinecounty.gov
 * Imports open bids to Supabase
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const cheerio = require('cheerio');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BIDS_URL = 'https://www.racinecounty.gov/departments/finance/purchasing-rfps-and-bids';

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

async function scrape() {
  console.log('🏛️  Fetching Racine County bids page...');

  const res = await fetch(BIDS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${BIDS_URL}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  console.log('📋 Parsing bids table...');

  const bids = [];

  // Look for tables on the page — Racine County uses HTML tables for bid listings
  $('table').each((tableIdx, table) => {
    const rows = $(table).find('tr');

    rows.each((i, row) => {
      const cells = $(row).find('td, th');
      if (cells.length < 3) return; // Need at least RFP#, Title, dates

      const cellTexts = [];
      cells.each((j, cell) => {
        cellTexts.push($(cell).text().trim());
      });

      // Skip header rows
      const firstCell = cellTexts[0].toLowerCase();
      if (firstCell.includes('rfp') && firstCell.includes('number')) return;
      if (firstCell === '' && cellTexts.every(c => c === '')) return;

      // Try to extract link from the row
      let link = null;
      $(row).find('a').each((j, a) => {
        const href = $(a).attr('href');
        if (href && (href.includes('.pdf') || href.includes('rfp') || href.includes('bid'))) {
          link = href;
        }
      });
      // Fall back to any link in the row
      if (!link) {
        const firstLink = $(row).find('a').first().attr('href');
        if (firstLink) link = firstLink;
      }

      // Make link absolute
      if (link && !link.startsWith('http')) {
        link = 'https://www.racinecounty.gov' + (link.startsWith('/') ? '' : '/') + link;
      }

      // Parse columns — expected: RFP Number, Title, Starting, Closing, Status
      // But column count may vary; adapt to what we find
      let rfpNumber = null;
      let title = null;
      let startDate = null;
      let closeDate = null;
      let status = null;

      if (cellTexts.length >= 5) {
        rfpNumber = cellTexts[0];
        title = cellTexts[1];
        startDate = cellTexts[2];
        closeDate = cellTexts[3];
        status = cellTexts[4];
      } else if (cellTexts.length >= 4) {
        rfpNumber = cellTexts[0];
        title = cellTexts[1];
        startDate = cellTexts[2];
        closeDate = cellTexts[3];
      } else if (cellTexts.length >= 3) {
        rfpNumber = cellTexts[0];
        title = cellTexts[1];
        closeDate = cellTexts[2];
      }

      // Clean up "NEW!" badge text that gets appended to titles.
      // Covers "NEW", "NEW!", "NEW!!", "new!", with or without whitespace.
      if (title) title = title.replace(/\s*NEW!{0,3}\s*$/i, '').trim();

      // Skip if no meaningful title
      if (!title || title.length < 3) return;

      // Skip closed/awarded bids
      if (status && /closed|awarded|cancel/i.test(status)) return;

      bids.push({
        rfpNumber,
        title,
        startDate,
        closeDate,
        status,
        link,
        rawCells: cellTexts,
      });
    });
  });

  // Also check for bids in list/div format (some county sites use divs instead of tables)
  if (bids.length === 0) {
    console.log('  No table bids found, checking for div/list format...');

    // Look for common patterns in the page content
    $('a').each((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href') || '';

      // Look for links that look like bid documents
      if (text.length > 10 && (href.includes('.pdf') || href.includes('bid') || href.includes('rfp'))) {
        // Check surrounding text for dates
        const parent = $(el).parent().text().trim();
        const dateMatch = parent.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g);

        let fullHref = href;
        if (!fullHref.startsWith('http')) {
          fullHref = 'https://www.racinecounty.gov' + (fullHref.startsWith('/') ? '' : '/') + fullHref;
        }

        bids.push({
          rfpNumber: null,
          title: text,
          startDate: dateMatch?.[0] || null,
          closeDate: dateMatch?.[1] || dateMatch?.[0] || null,
          status: 'Open',
          link: fullHref,
          rawCells: [text],
        });
      }
    });
  }

  console.log(`  Found ${bids.length} open bids\n`);

  if (bids.length === 0) {
    console.log('⚠️  No bids found — page structure may have changed.');
    console.log('  Page title:', $('title').text());
    console.log('  Tables found:', $('table').length);
    console.log('  First 500 chars of body:');
    console.log($('body').text().trim().slice(0, 500));
    return { source: 'racine-county', bidsFound: 0, imported: 0, skipped: 0, bids: [] };
  }

  // Import to Supabase
  let imported = 0;
  let skipped = 0;

  for (const bid of bids) {
    // Parse closing date
    let closeDate = null;
    if (bid.closeDate) {
      try {
        const d = new Date(bid.closeDate);
        if (!isNaN(d)) closeDate = d.toISOString().split('T')[0];
      } catch (e) {}
    }

    let postedDate = null;
    if (bid.startDate) {
      try {
        const d = new Date(bid.startDate);
        if (!isNaN(d)) postedDate = d.toISOString().split('T')[0];
      } catch (e) {}
    }

    // Create a unique ID from RFP number or title hash
    const idBase = bid.rfpNumber || bid.title.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30);
    const noticeId = `RACINE-${idBase}`;

    console.log(`  📌 ${bid.title}`);
    console.log(`     RFP: ${bid.rfpNumber || 'N/A'} | Closes: ${bid.closeDate || 'N/A'} | Status: ${bid.status || 'N/A'}`);

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: bid.title,
        source: 'racine-county',
        status: 'new',
        source_url: bid.link || BIDS_URL,
        agency: 'Racine County',
        response_deadline: closeDate,
        posted_date: postedDate,
        place_of_performance: 'Racine, WI',
        raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString(), page_url: BIDS_URL }),
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
    source: 'racine-county',
    timestamp: new Date().toISOString(),
    bidsFound: bids.length,
    imported,
    skipped,
    bids: bids.map(b => ({
      title: b.title,
      rfpNumber: b.rfpNumber,
      closeDate: b.closeDate,
      status: b.status,
      link: b.link,
    }))
  };

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${bids.length} bids`);

  console.log('\n__RACINE_JSON__');
  console.log(JSON.stringify(summary, null, 2));
  console.log('__RACINE_JSON_END__');

  return summary;
}

scrape().then(result => {
  console.log(`\n✅ Racine County fetch complete. Found ${result.bidsFound} bids (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
