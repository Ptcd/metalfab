#!/usr/bin/env node
/**
 * fetch-bidbuy.js - Scrapes public bid opportunities from BidBuy (Illinois eProcurement)
 * Site: bidbuy.illinois.gov
 * No login needed — public bid listings are available without authentication
 *
 * BidBuy uses JSF/PrimeFaces with dynamic DataTable rendering, so Puppeteer is required.
 * Two entry points:
 *   - Legacy: /bso/external/publicBids.sdo
 *   - New UI: /bso/view/search/external/advancedSearchBid.xhtml?openBids=true
 *
 * We try the new advancedSearch UI first (richer data), fall back to legacy publicBids.
 *
 * TCB Metalworks targets: welding, fabrication, metalwork, structural steel,
 * demolition, auto parts, scrap/salvage, HVAC ductwork, handrails, etc.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ADVANCED_SEARCH_URL = 'https://www.bidbuy.illinois.gov/bso/view/search/external/advancedSearchBid.xhtml?openBids=true';
const PUBLIC_BIDS_URL = 'https://www.bidbuy.illinois.gov/bso/external/publicBids.sdo';
const BID_DETAIL_BASE = 'https://www.bidbuy.illinois.gov/bso/external/bidDetail.sda';

const DEBUG = process.argv.includes('--debug');
const MAX_PAGES = parseInt(process.env.BIDBUY_MAX_PAGES || '10');

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
  const path = require('path').join(__dirname, `debug-bb-${name}.png`);
  return page.screenshot({ path, fullPage: true });
}

/**
 * Extract bids from the advanced search page (new UI).
 * The page uses PrimeFaces DataTable with lazy loading.
 */
async function extractAdvancedSearchBids(page) {
  console.log('  Extracting bids from advanced search page...');

  const bids = await page.evaluate(() => {
    const results = [];

    // PrimeFaces DataTable renders as <table> with class ui-datatable-data or similar
    // Also try generic table rows within the search results area
    const selectors = [
      '.ui-datatable-data tr',
      '.ui-datatable tbody tr',
      '[id*="searchResultsTable"] tr',
      '[id*="bidSearchResult"] tr',
      '[id*="dataTable"] tbody tr',
      'table.ui-datatable tr',
      '.search-results tr',
      '.bid-list-item',
      // Generic fallback — any table rows with enough cells
      'table tbody tr',
    ];

    let rows = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 2) {
        rows = Array.from(found);
        break;
      }
    }

    // Also try card-style layouts (newer BidBuy UI may use divs)
    if (rows.length === 0) {
      const cards = document.querySelectorAll('.bid-card, .search-result-card, .result-item, [class*="search-result"], [class*="bid-item"]');
      if (cards.length > 0) {
        cards.forEach(card => {
          const text = card.textContent.trim();
          const links = Array.from(card.querySelectorAll('a[href]')).map(a => ({
            text: a.textContent.trim(),
            href: a.href,
          }));
          results.push({
            cells: [text],
            links,
            html: card.innerHTML.substring(0, 800),
            isCard: true,
          });
        });
        return { rows: results, type: 'cards' };
      }
    }

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return;

      const cellTexts = Array.from(cells).map(c => c.textContent.trim());

      // Skip empty rows
      if (cellTexts.every(c => c === '')) return;

      const links = Array.from(row.querySelectorAll('a[href]')).map(a => ({
        text: a.textContent.trim(),
        href: a.href,
      }));

      results.push({
        cells: cellTexts,
        links,
        html: row.innerHTML.substring(0, 800),
        isCard: false,
      });
    });

    // Capture header row for column identification
    const headers = [];
    const headerCells = document.querySelectorAll('.ui-datatable th, table thead th, table thead td');
    headerCells.forEach(th => headers.push(th.textContent.trim()));

    // Get total page text for debugging
    const bodySnippet = document.body.textContent.substring(0, 3000);

    return { rows: results, headers, bodySnippet, type: 'table' };
  });

  return bids;
}

/**
 * Extract bids from the legacy publicBids.sdo page.
 */
async function extractLegacyBids(page) {
  console.log('  Extracting bids from legacy publicBids page...');

  const bids = await page.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll('table tr');

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return;

      const cellTexts = Array.from(cells).map(c => c.textContent.trim());
      if (cellTexts.every(c => c === '')) return;

      const links = Array.from(row.querySelectorAll('a[href]')).map(a => ({
        text: a.textContent.trim(),
        href: a.href,
      }));

      results.push({
        cells: cellTexts,
        links,
        html: row.innerHTML.substring(0, 800),
      });
    });

    const headers = [];
    document.querySelectorAll('table thead th, table tr th').forEach(th => {
      headers.push(th.textContent.trim());
    });

    return { rows: results, headers };
  });

  return bids;
}

/**
 * Parse a raw row into a structured bid object.
 * BidBuy columns typically: Bid Number/Doc ID, Title/Description, Agency, Opening Date, Status
 * But we adapt dynamically based on what headers and cell patterns we find.
 */
function parseBidRow(row, headers) {
  let bidNumber = null;
  let title = null;
  let agency = null;
  let openDate = null;
  let closeDate = null;
  let sourceUrl = null;

  // If we have links, the first link often goes to the bid detail page
  if (row.links && row.links.length > 0) {
    for (const link of row.links) {
      if (link.href && (link.href.includes('bidDetail') || link.href.includes('docId'))) {
        sourceUrl = link.href;
        // Extract doc ID from URL: docId=26-557THA-ENGCO-B-50362
        const match = link.href.match(/docId=([^&]+)/);
        if (match) bidNumber = match[1];
      }
      // Link text is often the bid title
      if (link.text && link.text.length > 10 && !title) {
        title = link.text;
      }
    }
  }

  if (row.isCard) {
    // Card-style: parse from text block
    const text = row.cells[0] || '';

    // Try to extract bid number pattern: XX-XXXYYY-ZZZZZ-B-NNNNN
    if (!bidNumber) {
      const bidMatch = text.match(/(\d{2}-\d{3}[A-Z]{2,6}-[A-Z0-9]+-[A-Z]-\d{4,6})/);
      if (bidMatch) bidNumber = bidMatch[1];
    }

    // Try date patterns
    const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/g);
    if (dateMatch && dateMatch.length > 0) {
      closeDate = dateMatch[dateMatch.length - 1]; // Last date is usually close/opening date
    }

    if (!title && text.length > 20) {
      title = text.split('\n').find(l => l.trim().length > 15) || text.substring(0, 200);
    }
  } else {
    // Table-style: use headers to map cells, or use heuristics
    const cells = row.cells || [];

    if (headers && headers.length > 0 && headers.length <= cells.length) {
      // Map by header names
      for (let i = 0; i < headers.length; i++) {
        const h = (headers[i] || '').toLowerCase();
        const val = (cells[i] || '').trim();
        if (!val) continue;

        if (h.includes('bid') && (h.includes('number') || h.includes('#') || h.includes('id') || h.includes('doc'))) {
          bidNumber = bidNumber || val;
        } else if (h.includes('title') || h.includes('description') || h.includes('name') || h.includes('solicitation')) {
          title = title || val;
        } else if (h.includes('agency') || h.includes('department') || h.includes('organization') || h.includes('buyer')) {
          agency = val;
        } else if (h.includes('open') || h.includes('close') || h.includes('due') || h.includes('deadline') || h.includes('date')) {
          closeDate = closeDate || val;
        } else if (h.includes('status') || h.includes('type')) {
          // skip status column
        }
      }
    }

    // Heuristic fallback if headers didn't help
    if (!bidNumber && !title) {
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i].trim();
        if (!cell) continue;

        // BidBuy doc IDs: "26-557THA-ENGCO-B-50362"
        if (!bidNumber && /^\d{2}-\d{3}[A-Z]/.test(cell)) {
          bidNumber = cell;
        }
        // Date: "04/15/2026" or "4/15/2026 2:00 PM"
        else if (!closeDate && /\d{1,2}\/\d{1,2}\/\d{4}/.test(cell)) {
          closeDate = cell;
        }
        // Agency: known Illinois agency patterns
        else if (!agency && cell.length > 3 && cell.length < 80 &&
                 (/DEPT|DEPARTMENT|AGENCY|COMMISSION|AUTHORITY|UNIVERSITY|BOARD|OFFICE|DIVISION/i.test(cell) ||
                  /^(IL |ILLINOIS |STATE |DEPT |CMS|IDOT|IDPH|IEMA|ISP|DCFS|DHS)/i.test(cell))) {
          agency = cell;
        }
        // Title: longest cell that isn't a date or bid number
        else if (!title && cell.length > 15 && !/^\d{2}-\d{3}/.test(cell) && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cell)) {
          title = cell;
        }
        // Shorter text as agency fallback
        else if (!agency && cell.length > 3 && cell.length <= 60) {
          agency = cell;
        }
      }
    }
  }

  // Clean up title
  if (title) title = title.replace(/\s+/g, ' ').trim();
  if (title && title.length > 300) title = title.substring(0, 300) + '...';

  // Use bid number as title fallback
  if (!title && bidNumber) title = `Illinois Bid ${bidNumber}`;

  if (!title || title.length < 5) return null;

  // Parse close date to ISO
  let closeDateISO = null;
  if (closeDate) {
    try {
      const d = new Date(closeDate);
      if (!isNaN(d)) closeDateISO = d.toISOString().split('T')[0];
    } catch (e) {}
  }

  // Build detail URL if we have a bid number but no source URL
  if (!sourceUrl && bidNumber) {
    sourceUrl = `${BID_DETAIL_BASE}?docId=${encodeURIComponent(bidNumber)}`;
  }

  const noticeId = `BIDBUY-${bidNumber || title.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`;

  return {
    noticeId,
    bidNumber,
    title,
    agency: agency || 'State of Illinois',
    closeDate,
    closeDateISO,
    sourceUrl: sourceUrl || ADVANCED_SEARCH_URL,
  };
}

/**
 * Try to paginate through the DataTable results.
 * PrimeFaces DataTables use .ui-paginator-next or similar buttons.
 */
async function goToNextPage(page) {
  const hasNext = await page.evaluate(() => {
    // PrimeFaces paginator next button
    const nextSelectors = [
      '.ui-paginator-next:not(.ui-state-disabled)',
      '.ui-paginator .ui-paginator-next:not(.ui-state-disabled)',
      'a.ui-paginator-next:not(.ui-state-disabled)',
      'span.ui-paginator-next:not(.ui-state-disabled)',
      '[class*="next"]:not([class*="disabled"])',
      'a[aria-label="Next Page"]',
      'button[aria-label="Next"]',
    ];

    for (const sel of nextSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (hasNext) {
    // Wait for AJAX/PrimeFaces to reload the table
    await new Promise(r => setTimeout(r, 3000));
  }

  return hasNext;
}

async function scrape() {
  console.log('🏛️  Launching browser for BidBuy Illinois...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    // ── Try Advanced Search UI first ──
    console.log('📋 Loading BidBuy advanced search (open bids)...');
    let usedLegacy = false;
    let rawBids = { rows: [], headers: [] };

    try {
      await page.goto(ADVANCED_SEARCH_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
      await debugScreenshot(page, 'advanced-initial');

      rawBids = await extractAdvancedSearchBids(page);
      console.log(`  Advanced search: ${rawBids.rows.length} rows, ${(rawBids.headers || []).length} headers`);
      if (rawBids.headers && rawBids.headers.length > 0) {
        console.log(`  Headers: ${rawBids.headers.join(' | ')}`);
      }

      if (rawBids.rows.length === 0) {
        console.log('  Advanced search returned no rows, trying legacy page...');
        throw new Error('No rows from advanced search');
      }
    } catch (advErr) {
      console.log(`  Advanced search failed or empty: ${advErr.message}`);
      console.log('📋 Falling back to legacy publicBids page...');

      await page.goto(PUBLIC_BIDS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
      await debugScreenshot(page, 'legacy-initial');

      rawBids = await extractLegacyBids(page);
      usedLegacy = true;
      console.log(`  Legacy page: ${rawBids.rows.length} rows, ${rawBids.headers.length} headers`);
    }

    // Log first few raw rows for debugging
    if (DEBUG) {
      rawBids.rows.slice(0, 3).forEach((r, i) => {
        console.log(`  Raw row ${i}: cells=${JSON.stringify((r.cells || []).slice(0, 5).map(c => c.slice(0, 60)))}`);
        console.log(`    links=${JSON.stringify((r.links || []).slice(0, 2))}`);
      });
    }

    // Collect all rows across pages
    let allRawRows = [...rawBids.rows];
    const headers = rawBids.headers || [];

    // Paginate to get more bids
    let pageNum = 1;
    while (pageNum < MAX_PAGES) {
      const hadNext = await goToNextPage(page);
      if (!hadNext) break;

      pageNum++;
      console.log(`  Page ${pageNum}...`);
      await debugScreenshot(page, `page-${pageNum}`);

      const moreBids = usedLegacy
        ? await extractLegacyBids(page)
        : await extractAdvancedSearchBids(page);

      if (moreBids.rows.length === 0) break;

      // Check for duplicate rows (same content = we've looped)
      const firstNewCell = (moreBids.rows[0].cells || [])[0];
      const firstOldCell = (allRawRows[allRawRows.length - 1].cells || [])[0];
      if (firstNewCell && firstNewCell === firstOldCell) break;

      allRawRows.push(...moreBids.rows);
      console.log(`  Cumulative: ${allRawRows.length} rows`);
    }

    console.log(`\n📊 Total raw rows extracted: ${allRawRows.length} across ${pageNum} page(s)`);

    // Parse and import
    let imported = 0;
    let skipped = 0;
    const allBids = [];
    const seenIds = new Set();

    for (const row of allRawRows) {
      const bid = parseBidRow(row, headers);
      if (!bid) continue;

      // Deduplicate within this run
      if (seenIds.has(bid.noticeId)) continue;
      seenIds.add(bid.noticeId);

      allBids.push(bid);
      console.log(`  📌 ${bid.title.slice(0, 75)}`);
      if (bid.bidNumber) console.log(`     Doc: ${bid.bidNumber} | Closes: ${bid.closeDate || 'N/A'} | ${bid.agency}`);

      try {
        await supabaseRequest('POST', 'opportunities', {
          sam_notice_id: bid.noticeId,
          title: bid.title,
          source: 'bidbuy',
          status: 'new',
          source_url: bid.sourceUrl,
          agency: bid.agency,
          response_deadline: bid.closeDateISO,
          place_of_performance: 'Illinois',
          raw_data: JSON.stringify({
            bidNumber: bid.bidNumber,
            title: bid.title,
            agency: bid.agency,
            closeDate: bid.closeDate,
            sourceUrl: bid.sourceUrl,
            scraped_at: new Date().toISOString(),
          }),
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
      source: 'bidbuy',
      timestamp: new Date().toISOString(),
      pageUsed: usedLegacy ? 'legacy-publicBids' : 'advancedSearch',
      pagesScraped: pageNum,
      bidsFound: allBids.length,
      imported,
      skipped,
      bids: allBids.map(b => ({
        bidNumber: b.bidNumber,
        title: b.title,
        agency: b.agency,
        closeDate: b.closeDate,
      })),
    };

    console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${allBids.length} bids`);

    console.log('\n__BIDBUY_JSON__');
    console.log(JSON.stringify(summary, null, 2));
    console.log('__BIDBUY_JSON_END__');

    return summary;

  } catch (err) {
    console.error('❌ Error:', err.message);
    await debugScreenshot(page, 'error');
    await browser.close();
    process.exit(1);
  }
}

scrape().then(result => {
  console.log(`\n✅ BidBuy fetch complete. Found ${result.bidsFound} bids (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
