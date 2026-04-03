#!/usr/bin/env node
/**
 * fetch-vendornet.js - Scrapes bids from Wisconsin VendorNet
 * Public page but uses ASP.NET AJAX grid — needs Puppeteer to render
 * No login required — bids are publicly visible at vendornet.wi.gov/Bids.aspx
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BIDS_URL = 'https://vendornet.wi.gov/Bids.aspx';
const DEBUG = process.argv.includes('--debug');

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

function debugScreenshot(page, name) {
  if (!DEBUG) return Promise.resolve();
  const path = require('path').join(__dirname, `debug-vn-${name}.png`);
  return page.screenshot({ path });
}

async function scrape() {
  console.log('🏛️  Launching browser for VendorNet...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    console.log('📋 Loading VendorNet bids page...');
    await page.goto(BIDS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    // Wait for the AJAX grid to load
    await new Promise(r => setTimeout(r, 5000));
    await debugScreenshot(page, 'initial');

    // Check if we need to wait for a specific element
    const hasGrid = await page.evaluate(() => {
      const grid = document.querySelector('[id*=BidsGrid]');
      return grid ? grid.innerHTML.length : 0;
    });
    console.log(`  Grid content length: ${hasGrid}`);

    if (hasGrid === 0) {
      // Grid might need more time or a postback to load
      console.log('  Waiting for grid to populate...');
      await new Promise(r => setTimeout(r, 5000));
      await debugScreenshot(page, 'wait');
    }

    // Extract all bids from the grid
    const bids = await page.evaluate(() => {
      const results = [];

      // Try multiple selectors for the grid
      const rows = document.querySelectorAll('[id*=BidsGrid] tr, table tr');

      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) return;

        const cellTexts = Array.from(cells).map(c => c.textContent.trim());

        // Skip header-like rows
        if (cellTexts[0] === '' && cellTexts.every(c => c === '')) return;

        // Extract links
        const links = Array.from(row.querySelectorAll('a')).map(a => ({
          text: a.textContent.trim(),
          href: a.href
        }));

        results.push({
          cells: cellTexts,
          links,
          html: row.innerHTML.substring(0, 500),
        });
      });

      // Also try getting data from any visible text in the grid panel
      const gridPanel = document.querySelector('[id*=BidsGridPanel]');
      const gridText = gridPanel ? gridPanel.textContent.trim().substring(0, 2000) : '';

      return { rows: results, gridText, totalRows: rows.length };
    });

    console.log(`  Found ${bids.rows.length} table rows, grid text: ${bids.gridText.length} chars`);

    if (bids.rows.length === 0 && bids.gridText.length < 50) {
      console.log('  Grid appears empty — trying to search for all bids...');

      // Click a search button if there is one, or try submitting the form
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('input[type=submit], button, a'));
        const searchBtn = buttons.find(b => {
          const t = (b.textContent || b.value || '').toLowerCase();
          return t.includes('search') || t.includes('find') || t.includes('show');
        });
        if (searchBtn) { searchBtn.click(); return true; }
        return false;
      });

      if (clicked) {
        console.log('  Clicked search button, waiting...');
        await new Promise(r => setTimeout(r, 5000));
        await debugScreenshot(page, 'after-search');
      }
    }

    // Re-extract after potential search
    const finalBids = await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll('tr');
      let isHeader = true;

      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;

        const cellTexts = Array.from(cells).map(c => c.textContent.trim());

        // Skip completely empty rows
        if (cellTexts.every(c => c === '')) return;

        // Get links
        const link = row.querySelector('a[href]');
        const href = link ? link.href : null;
        const linkText = link ? link.textContent.trim() : null;

        results.push({
          cells: cellTexts,
          link: href,
          linkText,
        });
      });

      // Get page text for debugging
      const bodyText = document.body.textContent.substring(0, 3000);

      return { rows: results, bodyText };
    });

    console.log(`  Final extraction: ${finalBids.rows.length} rows`);

    // Log first few rows for debugging
    finalBids.rows.slice(0, 5).forEach((r, i) => {
      console.log(`  Row ${i}: ${JSON.stringify(r.cells.slice(0, 4).map(c => c.slice(0, 50)))}`);
    });

    // Parse and import bids
    let imported = 0;
    let skipped = 0;
    const allBids = [];

    for (const row of finalBids.rows) {
      // Try to identify bid data from cell contents
      // VendorNet grid typically has: Bid Number, Agency, Description, Close Date, Manager
      if (row.cells.length < 3) continue;

      // Skip rows that look like headers
      const firstCell = row.cells[0].toLowerCase();
      if (firstCell.includes('bid') && firstCell.includes('number')) continue;
      if (firstCell.includes('agency')) continue;
      if (firstCell === '') continue;

      // Determine which cell is what based on content
      let bidNumber = null;
      let agency = null;
      let description = null;
      let closeDate = null;

      // VendorNet grid columns: Bid Number, Name/Description, Agency, Close Date, Manager
      // But cell order can vary. Use heuristics:
      for (let ci = 0; ci < row.cells.length; ci++) {
        const cell = row.cells[ci].trim();
        if (!cell) continue;

        // Bid numbers: "2026-UWMSN-01287-RFB", "510667", "CN-10457", etc.
        if (!bidNumber && (/^\d{4}-[A-Z]/.test(cell) || /^\d{5,7}$/.test(cell) || /^[A-Z]{2,4}-\d+/.test(cell) || /^\d+-\d+-\d+-[A-Z]+$/.test(cell))) {
          bidNumber = cell;
        }
        // Dates: "4/3/2026" or "4/21/2026 2:00:00 PM"
        else if (!closeDate && /\d{1,2}\/\d{1,2}\/\d{4}/.test(cell)) {
          closeDate = cell;
        }
        // Known agency patterns (all caps departments, "County of X", "UW X")
        else if (!agency && (/^(UW |COUNTY OF|TRANSPORTATION|CORRECTIONS|ADMINISTRATION|NATURAL RESOURCES|REVENUE|HEALTH|MILITARY)/i.test(cell) || /,\s*DEPT OF/i.test(cell))) {
          agency = cell;
        }
        // Description is usually the longest non-date, non-bid-number cell
        else if (!description && cell.length > 10 && !/^\d{4}-\w/.test(cell)) {
          description = cell;
        }
        // If we still don't have agency and this is a shorter text
        else if (!agency && cell.length > 3 && cell.length <= 60 && !/\d{1,2}\/\d{1,2}/.test(cell)) {
          agency = cell;
        }
      }

      // Use bid number as description if we didn't find one (some rows only show the bid ID)
      if (!description && bidNumber) {
        description = row.linkText || bidNumber;
      }

      // Use link text as better description if current description looks like a bid number
      if (description && /^\d{4}-[A-Z]/.test(description) && row.linkText && row.linkText.length > 10) {
        bidNumber = bidNumber || description;
        description = row.linkText;
      }

      if (!description || description.length < 5) continue;

      const noticeId = `VENDORNET-${bidNumber || description.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30)}`;

      const bid = {
        bidNumber,
        agency: agency || 'Wisconsin VendorNet',
        description,
        closeDate,
        link: row.link,
      };

      allBids.push(bid);
      console.log(`  📌 ${description.slice(0, 75)}`);

      // Parse close date
      let closeDateISO = null;
      if (closeDate) {
        try {
          const d = new Date(closeDate);
          if (!isNaN(d)) closeDateISO = d.toISOString().split('T')[0];
        } catch (e) {}
      }

      try {
        await supabaseRequest('POST', 'opportunities', {
          sam_notice_id: noticeId,
          title: description,
          source: 'vendornet',
          status: 'new',
          source_url: row.link || BIDS_URL,
          agency: bid.agency,
          response_deadline: closeDateISO,
          place_of_performance: 'Wisconsin',
          raw_data: JSON.stringify({ ...bid, scraped_at: new Date().toISOString() }),
        });
        imported++;
      } catch (e) {
        if (e.message.includes('duplicate') || e.message.includes('conflict') || e.message.includes('23505')) {
          skipped++;
        } else {
          console.error(`     Error: ${e.message}`);
        }
      }
    }

    await debugScreenshot(page, 'final');
    await browser.close();

    const summary = {
      source: 'vendornet',
      timestamp: new Date().toISOString(),
      bidsFound: allBids.length,
      imported,
      skipped,
      bids: allBids.map(b => ({
        description: b.description,
        agency: b.agency,
        closeDate: b.closeDate,
        bidNumber: b.bidNumber,
      }))
    };

    console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${allBids.length} bids`);

    console.log('\n__VENDORNET_JSON__');
    console.log(JSON.stringify(summary, null, 2));
    console.log('__VENDORNET_JSON_END__');

    return summary;

  } catch (err) {
    console.error('❌ Error:', err.message);
    await debugScreenshot(page, 'error');
    await browser.close();
    process.exit(1);
  }
}

scrape().then(result => {
  console.log(`\n✅ VendorNet fetch complete. Found ${result.bidsFound} bids (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
