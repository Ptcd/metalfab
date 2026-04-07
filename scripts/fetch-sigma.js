#!/usr/bin/env node
/**
 * fetch-sigma.js - Scrapes public bid opportunities from Michigan's SIGMA VSS
 * Site: sigma.michigan.gov (CGI Advantage Vendor Self Service)
 * No login needed — uses Public Access to view open solicitations
 *
 * SIGMA VSS is a CGI Advantage 4 SPA that requires browser rendering.
 * The portal has a "Public Access" button on the homepage that allows
 * viewing business opportunities/solicitations without an account.
 *
 * Michigan is a neighboring state to Wisconsin — cross-border contracts
 * are viable for TCB Metalworks (Racine, WI).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SIGMA_HOME = 'https://sigma.michigan.gov/PRDVSS1X1/Advantage4';
const SIGMA_ALT  = 'https://sigma.michigan.gov/webapp/PRDVSS2X1/AltSelfService';

const DEBUG = process.argv.includes('--debug');
const QUICK = process.argv.includes('--quick');
const MAX_PAGES = parseInt(process.env.SIGMA_MAX_PAGES || '5');

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
  const path = require('path').join(__dirname, `debug-sigma-${name}.png`);
  console.log(`  📸 Debug screenshot: ${path}`);
  return page.screenshot({ path, fullPage: true });
}

/**
 * Wait helper — waits for any of the given selectors to appear
 */
async function waitForAny(page, selectors, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) return sel;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

/**
 * Navigate to SIGMA and access public solicitation listings.
 * Strategy:
 *   1. Try the Advantage4 SPA portal — click "Public Access" button
 *   2. If that fails, try the legacy AltSelfService portal
 *   3. Navigate to the solicitation/business opportunities listing
 */
async function navigateToSolicitations(page) {
  // ── Strategy 1: Advantage4 SPA ──
  console.log('  Trying Advantage4 portal...');
  try {
    await page.goto(SIGMA_HOME, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 3000));
    await debugScreenshot(page, '01-home');

    const pageTitle = await page.title();
    console.log(`  Page title: ${pageTitle}`);
    console.log(`  URL: ${page.url()}`);

    // SIGMA is an Angular (CGI Advantage4) SPA with a carousel of div[role="tab"] items
    // The one we need is "View Published Solicitations"
    const publicAccessClicked = await page.evaluate(() => {
      // First try: Angular carousel tabs (confirmed working via browser inspection)
      const tabs = document.querySelectorAll('div[role="tab"]');
      for (const tab of tabs) {
        const text = tab.textContent.trim();
        if (text === 'View Published Solicitations' || text.includes('Published Solicitation')) {
          tab.click();
          return text;
        }
      }
      // Fallback: any clickable element with relevant text
      const selectors = ['div', 'a', 'button', 'span', 'h2'];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = (el.textContent || '').trim().toLowerCase();
          if ((text === 'view published solicitations' || text.includes('published solicitation')) && el.children.length < 5) {
            el.click();
            return text;
          }
        }
      }
      return null;
    });

    if (publicAccessClicked) {
      console.log(`  Clicked: "${publicAccessClicked}"`);
      await new Promise(r => setTimeout(r, 5000));
      await debugScreenshot(page, '02-after-public-access');
      return true;
    }

    // If no Public Access button, try clicking carousel/action items on Advantage4
    const actionClicked = await page.evaluate(() => {
      // Advantage4 uses a "What would you like to do?" carousel
      const actions = document.querySelectorAll('[class*="carousel"] a, [class*="action"] a, [class*="tile"] a, [class*="card"] a');
      for (const a of actions) {
        const text = (a.textContent || '').trim().toLowerCase();
        if (text.includes('solicitation') || text.includes('bid') ||
            text.includes('opportunit') || text.includes('procurement')) {
          a.click();
          return text;
        }
      }
      return null;
    });

    if (actionClicked) {
      console.log(`  Clicked action: "${actionClicked}"`);
      await new Promise(r => setTimeout(r, 5000));
      await debugScreenshot(page, '02-after-action');
      return true;
    }

    console.log('  No public access button found on Advantage4 portal');
  } catch (e) {
    console.log(`  Advantage4 failed: ${e.message}`);
  }

  // ── Strategy 2: AltSelfService legacy portal ──
  console.log('  Trying AltSelfService portal...');
  try {
    await page.goto(SIGMA_ALT, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 3000));
    await debugScreenshot(page, '03-altselfservice');

    console.log(`  URL: ${page.url()}`);

    // AltSelfService has a "Public Access" button on the left sidebar
    const clicked = await page.evaluate(() => {
      const allEls = document.querySelectorAll('a, button, input[type="button"], input[type="submit"], span, div');
      for (const el of allEls) {
        const text = (el.textContent || el.value || el.getAttribute('alt') || '').trim().toLowerCase();
        if (text.includes('public access') || text === 'public') {
          el.click();
          return text;
        }
      }
      // Also check image alt text and button values
      const imgs = document.querySelectorAll('img, input[type="image"]');
      for (const img of imgs) {
        const alt = (img.alt || img.title || '').toLowerCase();
        if (alt.includes('public') || alt.includes('solicitation') || alt.includes('opportunity')) {
          img.click();
          return alt;
        }
      }
      return null;
    });

    if (clicked) {
      console.log(`  Clicked: "${clicked}"`);
      await new Promise(r => setTimeout(r, 5000));
      await debugScreenshot(page, '04-after-public-legacy');

      // Now look for solicitation search link in the menu
      const navClicked = await page.evaluate(() => {
        const links = document.querySelectorAll('a, button, span');
        for (const l of links) {
          const text = (l.textContent || '').trim().toLowerCase();
          if (text.includes('solicitation') || text.includes('business opportunit') ||
              text.includes('open bid') || text.includes('procurement')) {
            l.click();
            return text;
          }
        }
        return null;
      });

      if (navClicked) {
        console.log(`  Navigated to: "${navClicked}"`);
        await new Promise(r => setTimeout(r, 5000));
      }
      return true;
    }
    console.log('  No public access button found on AltSelfService either');
  } catch (e) {
    console.log(`  AltSelfService failed: ${e.message}`);
  }

  // ── Strategy 3: Direct URL patterns for CGI Advantage solicitation search ──
  console.log('  Trying direct solicitation search URLs...');
  const directUrls = [
    'https://sigma.michigan.gov/PRDVSS1X1/Advantage4#/vss/search/solicitations',
    'https://sigma.michigan.gov/PRDVSS1X1/Advantage4#/vss/solicitations',
    'https://sigma.michigan.gov/PRDVSS1X1/Advantage4#/vss/public/solicitations',
    'https://sigma.michigan.gov/webapp/PRDVSS2X1/AltSelfService?cmd=SourcingSearchPublic',
    'https://sigma.michigan.gov/webapp/PRDVSS2X1/AltSelfService?cmd=BidSearch',
  ];

  for (const url of directUrls) {
    try {
      console.log(`  Trying: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));

      // Check if we landed on a search/listing page
      const hasContent = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return text.includes('solicitation') || text.includes('Solicitation') ||
               text.includes('opportunity') || text.includes('Opportunity') ||
               text.includes('bid') || text.includes('RFP') ||
               text.includes('search') || text.includes('Search');
      });

      if (hasContent) {
        console.log(`  Found content at: ${url}`);
        await debugScreenshot(page, '05-direct-url');
        return true;
      }
    } catch (e) {
      // continue to next URL
    }
  }

  return false;
}

/**
 * Extract solicitation listings from the current page.
 * CGI Advantage uses various table/grid/card layouts.
 */
async function extractSolicitations(page) {
  return await page.evaluate(() => {
    const results = [];

    // ── Strategy A: Table rows ──
    const tableSelectors = [
      'table tbody tr',
      '[class*="datatable"] tbody tr',
      '[class*="DataTable"] tbody tr',
      '[class*="grid"] [class*="row"]',
      '[class*="solicitation"] tr',
      '[role="grid"] [role="row"]',
    ];

    let rows = [];
    for (const sel of tableSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 1) {
        rows = Array.from(found);
        break;
      }
    }

    if (rows.length > 0) {
      // Get headers
      const headerRow = document.querySelector('table thead tr, [role="grid"] [role="columnheader"]');
      const headers = headerRow
        ? Array.from(headerRow.querySelectorAll('th, [role="columnheader"]')).map(h => h.textContent.trim().toLowerCase())
        : [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, [role="gridcell"]')).map(c => c.textContent.trim());
        const links = Array.from(row.querySelectorAll('a')).map(a => ({
          href: a.href,
          text: a.textContent.trim()
        }));

        if (cells.length < 2 || cells.every(c => !c)) continue;

        results.push({ cells, headers, links, type: 'table' });
      }
    }

    // ── Strategy B: Card/tile layout ──
    if (results.length === 0) {
      const cardSelectors = [
        '[class*="solicitation-card"]',
        '[class*="opportunity-card"]',
        '[class*="bid-card"]',
        '[class*="search-result"]',
        '[class*="result-item"]',
        '[class*="list-item"]',
        '[class*="Card"]',
        'mat-card',
        '.card',
      ];

      for (const sel of cardSelectors) {
        const cards = document.querySelectorAll(sel);
        if (cards.length > 0) {
          for (const card of cards) {
            const text = card.textContent.trim();
            const links = Array.from(card.querySelectorAll('a')).map(a => ({
              href: a.href,
              text: a.textContent.trim()
            }));
            if (text.length > 10) {
              results.push({ cells: [text], headers: [], links, type: 'card' });
            }
          }
          break;
        }
      }
    }

    // ── Strategy C: Any links containing solicitation patterns ──
    if (results.length === 0) {
      const allLinks = document.querySelectorAll('a');
      for (const a of allLinks) {
        const href = a.href || '';
        const text = a.textContent.trim();
        if ((href.includes('solicitation') || href.includes('Solicitation') ||
             href.includes('bid') || href.includes('opportunity')) &&
            text.length > 5) {
          results.push({ cells: [text], headers: [], links: [{ href, text }], type: 'link' });
        }
      }
    }

    // ── Strategy D: Angular CGI Advantage grid (SIGMA confirmed structure) ──
    // The grid renders data in <label> elements and <span> elements
    // RFP IDs are in spans matching pattern RFP-XXX-nnnnn or IFB-XXX-nnnnn
    if (results.length === 0) {
      const labels = Array.from(document.querySelectorAll('label'));
      const allText = labels.map(l => l.textContent.trim()).filter(t => t.length > 0);

      // Find RFP/IFB ID spans as row anchors
      const idSpans = Array.from(document.querySelectorAll('span, a'))
        .filter(s => /^(RFP|IFB|ITB|RFQ)-[A-Z]{3}-\d{6,}/.test(s.textContent.trim()));

      if (idSpans.length > 0) {
        // For each ID, walk up to find the row container, then extract fields
        for (const idEl of idSpans) {
          const solId = idEl.textContent.trim();
          // Skip duplicate IDs (rendered multiple times)
          if (results.find(r => r.cells[2] === solId)) continue;

          // Walk up to find the row-like container (has multiple label children)
          let rowEl = idEl;
          for (let i = 0; i < 10; i++) {
            rowEl = rowEl.parentElement;
            if (!rowEl) break;
            const rowLabels = rowEl.querySelectorAll('label');
            if (rowLabels.length >= 4) break;
          }

          if (rowEl) {
            const rowLabels = Array.from(rowEl.querySelectorAll('label')).map(l => l.textContent.trim()).filter(t => t.length > 0);
            // Fields: Description, Dept, Buyer, Type, Category, Date, Countdown, Status
            let desc = '', dept = '', closeDate = '', type = '', status = '';
            for (const lt of rowLabels) {
              if (lt.match(/^\d{2}\/\d{2}\/\d{4}/)) { closeDate = lt; }
              else if (lt === 'Open' || lt === 'Amended' || lt === 'Closed') { status = lt; }
              else if (lt.includes('Request for') || lt.includes('Invitation')) { type = lt; }
              else if (lt.match(/^\d+ Days?,/)) { continue; } // countdown
              else if (lt.includes('Records')) { continue; }
              else if (lt === 'Construction' || lt === 'Services' || lt === 'Goods' || lt === '-') { continue; }
              else if (!desc && lt.length > 15) { desc = lt; }
              else if (!dept && lt.length > 3 && lt.length < 80) { dept = lt; }
            }

            if (desc) {
              results.push({
                cells: [desc, dept, solId, closeDate, type, status],
                headers: ['description', 'department', 'solicitation_id', 'close_date', 'type', 'status'],
                links: idEl.href ? [{ href: idEl.href, text: solId }] : [],
                type: 'angular-grid'
              });
            }
          }
        }
      }
    }

    // ── Strategy E: Grab all visible text blocks that look like bid listings ──
    if (results.length === 0) {
      const textBlocks = document.querySelectorAll('p, div, span, li');
      for (const el of textBlocks) {
        const text = el.textContent.trim();
        if (/\b(RFP|ITB|RFQ|IFB|RFI|SOL|BID)[-\s]?\d/i.test(text) && text.length > 20 && text.length < 500) {
          results.push({ cells: [text], headers: [], links: [], type: 'text' });
        }
      }
    }

    return results;
  });
}

/**
 * Parse a raw extracted row into a structured bid object.
 */
function parseSolicitation(raw) {
  let solNumber = null;
  let title = null;
  let agency = null;
  let closeDate = null;
  let openDate = null;
  let sourceUrl = null;
  let status = null;

  // Extract from links first
  if (raw.links && raw.links.length > 0) {
    for (const link of raw.links) {
      if (link.href && (link.href.includes('solicitation') || link.href.includes('Solicitation') ||
          link.href.includes('bid') || link.href.includes('Bid'))) {
        sourceUrl = link.href;
        // Try to extract solicitation number from URL
        const match = link.href.match(/solicitation_number=([^&]+)/);
        if (match) solNumber = match[1];
      }
      if (link.text && link.text.length > 10 && !title) {
        title = link.text;
      }
    }
  }

  if (raw.type === 'table' && raw.headers.length > 0) {
    // Map by header names
    for (let i = 0; i < raw.headers.length && i < raw.cells.length; i++) {
      const h = raw.headers[i];
      const val = raw.cells[i].trim();
      if (!val) continue;

      if (h.includes('solicitation') && (h.includes('number') || h.includes('#') || h.includes('id'))) {
        solNumber = solNumber || val;
      } else if (h.includes('number') || h.includes('#') || h.includes('id')) {
        solNumber = solNumber || val;
      } else if (h.includes('title') || h.includes('description') || h.includes('name') || h.includes('project')) {
        title = title || val;
      } else if (h.includes('agency') || h.includes('department') || h.includes('organization') || h.includes('buyer') || h.includes('entity')) {
        agency = val;
      } else if (h.includes('close') || h.includes('due') || h.includes('deadline') || h.includes('end') || h.includes('response')) {
        closeDate = closeDate || val;
      } else if (h.includes('open') || h.includes('start') || h.includes('issue') || h.includes('post')) {
        openDate = openDate || val;
      } else if (h.includes('status') || h.includes('state')) {
        status = val;
      }
    }
  }

  // Heuristic fallback for table rows without helpful headers
  if (!solNumber && !title) {
    const cells = raw.cells || [];
    for (const cell of cells) {
      const val = cell.trim();
      if (!val) continue;

      // Solicitation number patterns: RFP-171-260000000798-3, ITB-..., etc.
      if (!solNumber && /^(RFP|ITB|RFQ|IFB|RFI|SOL|BID)[-\s]?\d/i.test(val)) {
        solNumber = val;
      } else if (!solNumber && /^\d{2,4}-\d+/.test(val) && val.length < 50) {
        solNumber = val;
      }
      // Date patterns
      else if (!closeDate && /\d{1,2}\/\d{1,2}\/\d{4}/.test(val)) {
        closeDate = closeDate || val;
      }
      // Agency: Michigan department patterns
      else if (!agency && val.length > 3 && val.length < 100 &&
               (/DEPT|DEPARTMENT|AGENCY|COMMISSION|AUTHORITY|UNIVERSITY|BOARD|OFFICE|DIVISION|MICHIGAN|MDOT|DTMB|DHHS|MDOC|DNR/i.test(val))) {
        agency = val;
      }
      // Title: longest meaningful text
      else if (!title && val.length > 15 && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(val)) {
        title = val;
      }
    }
  }

  // For card/text type, try to parse from text block
  if (raw.type === 'card' || raw.type === 'text') {
    const text = raw.cells[0] || '';

    if (!solNumber) {
      const solMatch = text.match(/((?:RFP|ITB|RFQ|IFB|RFI|SOL|BID)[-\s]?\d[\w-]+)/i);
      if (solMatch) solNumber = solMatch[1];
    }

    if (!closeDate) {
      const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/g);
      if (dateMatch) closeDate = dateMatch[dateMatch.length - 1];
    }

    if (!title) {
      // Use the first line or first meaningful chunk
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 10);
      title = lines[0] || text.substring(0, 200);
    }
  }

  // Clean up
  if (title) {
    title = title.replace(/\s+/g, ' ').trim();
    if (title.length > 300) title = title.substring(0, 300) + '...';
  }
  if (!title && solNumber) title = `Michigan Solicitation ${solNumber}`;
  if (!title || title.length < 5) return null;

  // Parse close date to ISO
  let closeDateISO = null;
  if (closeDate) {
    try {
      const d = new Date(closeDate);
      if (!isNaN(d)) closeDateISO = d.toISOString().split('T')[0];
    } catch (e) {}
  }

  // Build source URL if we have a solicitation number but no link
  if (!sourceUrl && solNumber) {
    sourceUrl = `${SIGMA_HOME}?solicitation_number=${encodeURIComponent(solNumber)}`;
  }

  const noticeId = `SIGMA-${solNumber || title.replace(/[^a-zA-Z0-9]/g, '').slice(0, 50)}`;

  return {
    noticeId,
    solNumber,
    title,
    agency: agency || 'State of Michigan',
    closeDate,
    closeDateISO,
    openDate,
    status,
    sourceUrl: sourceUrl || SIGMA_HOME,
  };
}

/**
 * Try to click "Search" or load all results on the solicitation page.
 */
async function triggerSearch(page) {
  // Click any "Search" button to load results
  const searched = await page.evaluate(() => {
    const btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], a');
    for (const btn of btns) {
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      if (text === 'search' || text === 'find' || text === 'go' || text === 'submit' ||
          text === 'search solicitations' || text === 'view all') {
        btn.click();
        return text;
      }
    }
    return null;
  });

  if (searched) {
    console.log(`  Clicked search: "${searched}"`);
    await new Promise(r => setTimeout(r, 5000));
    await debugScreenshot(page, '06-after-search');
  }

  return searched;
}

/**
 * Try pagination — look for Next button in various frameworks.
 */
async function goToNextPage(page) {
  const hasNext = await page.evaluate(() => {
    const selectors = [
      'a[aria-label="Next"]',
      'a[aria-label="Next Page"]',
      'button[aria-label="Next"]',
      '[class*="next"]:not([class*="disabled"]):not([disabled])',
      '[class*="Next"]:not([class*="disabled"]):not([disabled])',
      '.pagination .next:not(.disabled) a',
      'a.next:not(.disabled)',
      'li.next:not(.disabled) a',
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && !btn.classList.contains('disabled')) {
        btn.click();
        return true;
      }
    }

    // Also try buttons with ">" or ">>" text
    const allBtns = document.querySelectorAll('button, a');
    for (const btn of allBtns) {
      const text = (btn.textContent || '').trim();
      if ((text === '>' || text === '>>' || text === 'Next' || text === 'next') &&
          !btn.disabled && !btn.classList.contains('disabled')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (hasNext) {
    await new Promise(r => setTimeout(r, 4000));
  }
  return hasNext;
}

/**
 * Intercept XHR/fetch responses to capture any JSON data about solicitations.
 */
function setupResponseInterceptor(page) {
  const capturedData = [];

  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    // Look for JSON responses that might contain solicitation data
    if (contentType.includes('application/json') &&
        (url.includes('solicitation') || url.includes('Solicitation') ||
         url.includes('sourcing') || url.includes('Sourcing') ||
         url.includes('bid') || url.includes('opportunity') ||
         url.includes('search') || url.includes('api'))) {
      try {
        const json = await response.json();
        capturedData.push({ url, data: json });
        console.log(`  📡 Intercepted JSON from: ${url.substring(0, 100)}`);
      } catch (e) {
        // not valid JSON, skip
      }
    }
  });

  return capturedData;
}

async function scrape() {
  console.log('🏛️  Fetching Michigan SIGMA procurement opportunities...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Set up network interceptor to catch API responses
  const capturedData = setupResponseInterceptor(page);

  try {
    // Navigate to solicitation listings
    const found = await navigateToSolicitations(page);

    if (!found) {
      console.log('  ⚠️  Could not navigate to solicitation listings via UI');
      console.log('  Attempting to extract any visible content from current page...');
    }

    // Try triggering a search if we're on a search page
    await triggerSearch(page);

    // Try to set "100" per page for more results
    await page.evaluate(() => {
      const els = document.querySelectorAll('a, span, button');
      for (const el of els) {
        if (el.textContent.trim() === '100') { el.click(); return; }
      }
    });
    await new Promise(r => setTimeout(r, 3000));

    await debugScreenshot(page, '07-pre-extract');

    // Log current page content for debugging
    const pageInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyLength: document.body.innerText.length,
        bodyPreview: document.body.innerText.substring(0, 500),
      };
    });
    console.log(`\n  Current URL: ${pageInfo.url}`);
    console.log(`  Title: ${pageInfo.title}`);
    console.log(`  Content length: ${pageInfo.bodyLength} chars`);
    if (DEBUG) console.log(`  Preview: ${pageInfo.bodyPreview.substring(0, 200)}...`);

    // ── Extract bids from DOM ──
    let allBids = [];
    const seenIds = new Set();
    let pageNum = 0;

    do {
      pageNum++;
      console.log(`\n  Page ${pageNum}...`);

      const rawItems = await extractSolicitations(page);
      console.log(`  Found ${rawItems.length} raw items on page ${pageNum}`);

      if (rawItems.length === 0 && pageNum === 1) {
        // Check captured API data as fallback
        if (capturedData.length > 0) {
          console.log(`  📡 Processing ${capturedData.length} intercepted API responses...`);
          for (const capture of capturedData) {
            const data = capture.data;
            // Try to parse various JSON structures
            const items = Array.isArray(data) ? data :
                          data.results ? data.results :
                          data.data ? data.data :
                          data.solicitations ? data.solicitations :
                          data.items ? data.items :
                          data.content ? data.content : [];

            if (Array.isArray(items) && items.length > 0) {
              console.log(`  Found ${items.length} items in API response`);
              for (const item of items) {
                const bid = {
                  noticeId: `SIGMA-${item.solicitationNumber || item.id || item.solicitation_number || Math.random().toString(36).slice(2, 10)}`,
                  solNumber: item.solicitationNumber || item.solicitation_number || item.id || null,
                  title: item.title || item.description || item.name || item.projectDescription || item.solicitation_title || 'Untitled',
                  agency: item.agency || item.department || item.organizationName || item.buyer || 'State of Michigan',
                  closeDate: item.closeDate || item.closingDate || item.responseDeadline || item.close_date || null,
                  closeDateISO: null,
                  openDate: item.openDate || item.issueDate || item.open_date || null,
                  status: item.status || null,
                  sourceUrl: item.url || `${SIGMA_HOME}?solicitation_number=${encodeURIComponent(item.solicitationNumber || item.id || '')}`,
                };

                if (bid.closeDate) {
                  try {
                    const d = new Date(bid.closeDate);
                    if (!isNaN(d)) bid.closeDateISO = d.toISOString().split('T')[0];
                  } catch (e) {}
                }

                if (!seenIds.has(bid.noticeId)) {
                  seenIds.add(bid.noticeId);
                  allBids.push(bid);
                }
              }
            }
          }
        }
        break;
      }

      for (const raw of rawItems) {
        const bid = parseSolicitation(raw);
        if (!bid) continue;

        if (seenIds.has(bid.noticeId)) continue;
        seenIds.add(bid.noticeId);
        allBids.push(bid);
      }

      if (QUICK || pageNum >= MAX_PAGES) break;

    } while (await goToNextPage(page));

    // ── Import to Supabase ──
    let imported = 0;
    let skipped = 0;

    console.log(`\n📋 Processing ${allBids.length} solicitations...`);

    for (const bid of allBids) {
      console.log(`  📌 ${bid.title.slice(0, 75)}`);
      if (bid.solNumber) console.log(`     Sol: ${bid.solNumber} | Closes: ${bid.closeDate || 'N/A'} | ${bid.agency}`);

      try {
        await supabaseRequest('POST', 'opportunities', {
          sam_notice_id: bid.noticeId,
          title: bid.title,
          source: 'sigma',
          status: 'new',
          source_url: bid.sourceUrl,
          agency: bid.agency,
          response_deadline: bid.closeDateISO,
          place_of_performance: 'Michigan',
          raw_data: JSON.stringify({
            solNumber: bid.solNumber,
            title: bid.title,
            agency: bid.agency,
            closeDate: bid.closeDate,
            openDate: bid.openDate,
            solStatus: bid.status,
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
      source: 'sigma',
      timestamp: new Date().toISOString(),
      portalUrl: SIGMA_HOME,
      pagesScraped: pageNum,
      bidsFound: allBids.length,
      imported,
      skipped,
      apiResponsesCaptured: capturedData.length,
      bids: allBids.map(b => ({
        solNumber: b.solNumber,
        title: b.title,
        agency: b.agency,
        closeDate: b.closeDate,
      })),
    };

    console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${allBids.length} solicitations`);

    console.log('\n__SIGMA_JSON__');
    console.log(JSON.stringify(summary, null, 2));
    console.log('__SIGMA_JSON_END__');

    return summary;

  } catch (err) {
    console.error('❌ Error:', err.message);
    await debugScreenshot(page, 'error');
    await browser.close();
    process.exit(1);
  }
}

scrape().then(result => {
  console.log(`\n✅ SIGMA fetch complete. Found ${result.bidsFound} solicitations (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
