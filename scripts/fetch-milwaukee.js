#!/usr/bin/env node
/**
 * fetch-milwaukee.js - Scrapes public bids from City of Milwaukee Purchasing
 * No login needed — public HTML tables at city.milwaukee.gov
 * Tables: RFPs, Informal Bids (<$50K), Formal Bids (>$50K), RFIs, Other
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const cheerio = require('cheerio');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BIDS_URL = 'https://city.milwaukee.gov/Purchasing/ContractOpps/Bids.htm';

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
  console.log('🏙️  Fetching City of Milwaukee bids page...');

  // Node's built-in fetch gets 403'd — use curl as a workaround
  // Retry up to 3 times with increasing delays to handle intermittent failures
  const { execSync } = require('child_process');
  let html;
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      html = execSync(
        `curl -s -L --connect-timeout 15 --max-time 30 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -H "Accept: text/html,application/xhtml+xml" -H "Accept-Language: en-US,en;q=0.9" "${BIDS_URL}"`,
        { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 45000 }
      );
      if (html && html.length > 500 && html.includes('<table')) break;
      console.log(`  Attempt ${attempt}: got ${html ? html.length : 0} bytes but no tables — retrying...`);
      html = null;
    } catch (e) {
      console.log(`  Attempt ${attempt} failed: ${e.message.slice(0, 80)}`);
      html = null;
    }
    if (attempt < MAX_RETRIES) {
      const delay = attempt * 3000;
      console.log(`  Waiting ${delay/1000}s before retry...`);
      execSync(`ping -n ${Math.ceil(delay/1000)} 127.0.0.1 > nul`, { encoding: 'utf8', timeout: delay + 2000 });
    }
  }
  if (!html || html.length < 500) {
    throw new Error(`Failed to fetch ${BIDS_URL} after ${MAX_RETRIES} attempts`);
  }
  const $ = cheerio.load(html);

  console.log('📋 Parsing bid tables...');

  const bids = [];
  const seenBidNums = new Set(); // Dedupe — page has duplicate tables

  $('table').each((tableIdx, table) => {
    const rows = $(table).find('tr');

    rows.each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;

      const cellTexts = [];
      cells.each((j, cell) => {
        cellTexts.push($(cell).text().trim());
      });

      // Skip header rows (contain "DUE DATE" or "BID #")
      const firstCell = cellTexts[0].toLowerCase();
      if (firstCell.includes('due date') || firstCell.includes('rfp #') || firstCell.includes('bid #') || firstCell.includes('rfi #')) return;

      // Skip "no requests at this time" rows
      if (cellTexts.some(c => c.includes('no Requests') || c.includes('no Other') || c.includes('at this time'))) return;

      // Skip empty rows
      if (cellTexts.every(c => c === '')) return;

      // Expected columns: Due Date/Time, Bid/RFP #, Description, Purchasing Agent/Contact
      const dueDate = cellTexts[0] || null;
      const bidNum = cellTexts[1] || null;
      const description = cellTexts[2] || null;
      const contact = cellTexts[3] || null;

      if (!description || description.length < 5) return;
      if (!bidNum) return;

      // Deduplicate (page has some tables duplicated)
      const key = bidNum.replace(/\s+/g, '');
      if (seenBidNums.has(key)) return;
      seenBidNums.add(key);

      // Extract link
      let link = null;
      $(row).find('a').each((j, a) => {
        const href = $(a).attr('href');
        if (href && href.includes('/Purchasing/')) {
          link = href;
        }
      });

      if (link && !link.startsWith('http')) {
        link = 'https://city.milwaukee.gov' + (link.startsWith('/') ? '' : '/') + link;
      }

      // Extract contact email
      let email = null;
      const emailMatch = (contact || '').match(/[\w.+-]+@[\w.-]+\.\w+/);
      if (emailMatch) email = emailMatch[0];

      // Clean contact name (remove email)
      let contactName = contact ? contact.replace(/[\w.+-]+@[\w.-]+\.\w+/g, '').replace(/\s+/g, ' ').trim() : null;

      // Determine bid type from table context
      let bidType = 'bid';
      if (bidNum.toLowerCase().startsWith('rfp') || bidNum.toLowerCase().includes('rfp')) bidType = 'rfp';
      if (bidNum.toLowerCase().startsWith('rfi') || bidNum.toLowerCase().includes('rfi')) bidType = 'rfi';

      bids.push({
        bidNum,
        description,
        dueDate,
        contact: contactName,
        email,
        link,
        bidType,
      });
    });
  });

  console.log(`  Found ${bids.length} open bids\n`);

  if (bids.length === 0) {
    console.log('⚠️  No bids found — page structure may have changed.');
    return { source: 'milwaukee', bidsFound: 0, imported: 0, skipped: 0, bids: [] };
  }

  // Import to Supabase
  let imported = 0;
  let skipped = 0;

  for (const bid of bids) {
    // Parse due date
    let closeDate = null;
    if (bid.dueDate) {
      try {
        // Format: "Thursday, April 7, 2026 at 4:30 PM CT"
        const cleaned = bid.dueDate.replace(/\s+at\s+.*$/, '').replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '');
        const d = new Date(cleaned);
        if (!isNaN(d)) closeDate = d.toISOString().split('T')[0];
      } catch (e) {}
    }

    const noticeId = `MKE-${bid.bidNum.replace(/[^a-zA-Z0-9]/g, '')}`;

    console.log(`  📌 [${bid.bidType.toUpperCase()}] #${bid.bidNum}: ${bid.description.slice(0, 70)}`);
    console.log(`     Due: ${bid.dueDate || 'N/A'} | Contact: ${bid.contact || 'N/A'}`);

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: `[MKE ${bid.bidType.toUpperCase()} #${bid.bidNum}] ${bid.description}`,
        source: 'milwaukee',
        status: 'new',
        source_url: bid.link || BIDS_URL,
        agency: 'City of Milwaukee',
        response_deadline: closeDate,
        point_of_contact: bid.contact,
        contact_email: bid.email,
        place_of_performance: 'Milwaukee, WI',
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
    source: 'milwaukee',
    timestamp: new Date().toISOString(),
    bidsFound: bids.length,
    imported,
    skipped,
    bids: bids.map(b => ({
      bidNum: b.bidNum,
      description: b.description,
      dueDate: b.dueDate,
      bidType: b.bidType,
      link: b.link,
    }))
  };

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${bids.length} bids`);

  console.log('\n__MILWAUKEE_JSON__');
  console.log(JSON.stringify(summary, null, 2));
  console.log('__MILWAUKEE_JSON_END__');

  return summary;
}

scrape().then(result => {
  console.log(`\n✅ City of Milwaukee fetch complete. Found ${result.bidsFound} bids (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
