#!/usr/bin/env node
/**
 * fetch-stevens.js - Scrapes bidding projects from Stevens Construction plan room
 *
 * Stevens Construction Corp. (stevensconstruction.com) is a Wisconsin GC.
 * Their plan room at stevensconstructionplans.com is powered by Pantera Tools.
 *
 * Projects are login-only (no public grid), so we use Puppeteer to:
 *   1. Navigate to login page, fill credentials
 *   2. Wait for authenticated API call (projects?isBidding=true)
 *   3. Extract project data from the page
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BASE_URL = 'https://www.stevensconstructionplans.com';
const STEVENS_USER = process.env.STEVENS_USER || 'tcbmetalworks1';
const STEVENS_PASS = process.env.STEVENS_PASS || 'Steelbid123!';

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
  console.log('🏗️  Fetching Stevens Construction Plan Room (Pantera/Puppeteer)...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let projects = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Intercept the projects API response
    let projectsApiData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('api.tm.panteratools.com/projects') && url.includes('isBidding')) {
        try {
          const data = await response.json();
          if (Array.isArray(data)) {
            projectsApiData = data;
            console.log(`  📡 Intercepted projects API: ${data.length} projects`);
          }
        } catch (e) { /* ignore parse errors */ }
      }
    });

    // Navigate to login page
    console.log('  Navigating to login...');
    await page.goto(`${BASE_URL}/#p/signin`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Fill username
    const userFilled = await page.evaluate((user) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const userInput = inputs.find(i => {
        const ph = (i.placeholder || '').toLowerCase();
        return ph.includes('username') || ph.includes('user');
      });
      if (!userInput) return false;
      userInput.value = user;
      userInput.dispatchEvent(new Event('input', { bubbles: true }));
      userInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, STEVENS_USER);

    // Fill password
    const passFilled = await page.evaluate((pass) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const passInput = inputs.find(i => i.type === 'password' || (i.placeholder || '').toLowerCase().includes('password'));
      if (!passInput) return false;
      passInput.value = pass;
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      passInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, STEVENS_PASS);

    console.log(`  Login fields: user=${userFilled}, pass=${passFilled}`);

    if (!userFilled || !passFilled) {
      // Try typing directly
      console.log('  Trying direct type approach...');
      const inputs = await page.$$('input');
      for (const inp of inputs) {
        const ph = await inp.evaluate(el => el.placeholder);
        if (ph && ph.toLowerCase().includes('user')) {
          await inp.click({ clickCount: 3 });
          await inp.type(STEVENS_USER);
        }
        if (ph && ph.toLowerCase().includes('password')) {
          await inp.click({ clickCount: 3 });
          await inp.type(STEVENS_PASS);
        }
      }
    }

    // Click the Account Login button (second Login button)
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const loginButtons = buttons.filter(b => b.textContent.trim() === 'Login');
      if (loginButtons.length >= 2) loginButtons[1].click();
      else if (loginButtons.length === 1) loginButtons[0].click();
    });

    console.log('  Waiting for login...');
    await new Promise(r => setTimeout(r, 8000));

    // Check if we intercepted the API response
    if (projectsApiData && projectsApiData.length > 0) {
      console.log(`  ✅ Got ${projectsApiData.length} projects from API intercept`);
      projects = projectsApiData;
    } else {
      // Fallback: try to extract from page DOM
      console.log('  No API intercept, trying DOM extraction...');

      // Navigate to bidding projects if not already there
      const currentUrl = page.url();
      if (!currentUrl.includes('biddingprojects')) {
        await page.goto(`${BASE_URL}/#biddingprojects`, { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 5000));
      }

      // Check for API intercept again
      if (projectsApiData && projectsApiData.length > 0) {
        console.log(`  ✅ Got ${projectsApiData.length} projects from API intercept (after nav)`);
        projects = projectsApiData;
      } else {
        // Extract from DOM table
        const domProjects = await page.evaluate(() => {
          const rows = document.querySelectorAll('tr, [role="row"]');
          const results = [];
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td, [role="cell"]'));
            if (cells.length < 3) continue;
            const texts = cells.map(c => c.textContent.trim());
            // Skip header rows
            if (texts.some(t => /^(name|project|bid)/i.test(t) && t.length < 15)) continue;
            // Find project-like data
            const name = texts.find(t => t.length > 10 && !/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t) && !/^[A-Z]{2}$/.test(t));
            if (name) {
              results.push({
                name,
                allCells: texts,
              });
            }
          }
          return results;
        });

        if (domProjects.length > 0) {
          console.log(`  ✅ Got ${domProjects.length} projects from DOM`);
          // Convert DOM data to project format
          for (const dp of domProjects) {
            const dateMatch = dp.allCells.find(t => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t));
            const stateMatch = dp.allCells.find(t => /^[A-Z]{2}$/.test(t));
            const cityMatch = dp.allCells.find(t => t.length > 2 && t.length < 50 && t !== dp.name && !/\d{1,2}\/\d{1,2}/.test(t) && !/^[A-Z]{2}$/.test(t));

            projects.push({
              projectName: dp.name,
              city: cityMatch || '',
              state: stateMatch || 'WI',
              rDueText: dateMatch || null,
              _fromDom: true,
            });
          }
        } else {
          // Last resort: get page text
          const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
          console.log('  ⚠️  No projects found. Page text:', pageText.substring(0, 500));
        }
      }
    }

  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n  Found ${projects.length} projects total\n`);

  if (projects.length === 0) {
    console.log('ℹ️  No bidding projects found on Stevens Construction.');
    return { source: 'stevens', projectsFound: 0, imported: 0, skipped: 0 };
  }

  // Import to Supabase
  let imported = 0;
  let skipped = 0;

  for (const p of projects) {
    const name = (p.projectName || p.name || '').trim();
    if (!name || name.length < 5) continue;

    const city = p.city || '';
    const state = p.state || 'WI';
    const projId = p.projectId || p._id || name.replace(/\s+/g, '-').substring(0, 30);

    let bidDateISO = null;
    if (p.bidsDue) {
      bidDateISO = p.bidsDue.split('T')[0];
    } else if (p.rDueText) {
      const dm = p.rDueText.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (dm) {
        let yr = dm[3]; if (yr.length === 2) yr = '20' + yr;
        bidDateISO = `${yr}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
      }
    }

    const desc = (p.notes || '').trim();
    const contact = p.user?.displayName || null;

    console.log(`  📌 ${name}`);
    console.log(`     ${city ? city + ', ' : ''}${state} | Bid: ${p.rDueText || bidDateISO || 'unknown'}`);
    if (desc) console.log(`     Scope: ${desc.substring(0, 120)}...`);

    const noticeId = `STEVENS-${projId}`;
    let descText = `GC: Stevens Construction Corp.`;
    if (p.rDueText) descText += ` | Bid Date: ${p.rDueText}`;
    if (contact) descText += ` | Contact: ${contact}`;
    if (desc) descText += `\n\n${desc.substring(0, 2000)}`;

    try {
      await supabaseRequest('POST', 'opportunities', {
        sam_notice_id: noticeId,
        title: `[Stevens] ${name}`,
        source: 'stevens',
        status: 'new',
        source_url: `${BASE_URL}/#biddingprojects`,
        agency: 'Stevens Construction Corp.',
        response_deadline: bidDateISO,
        place_of_performance: city ? `${city}, ${state}` : state,
        description: descText,
        raw_data: JSON.stringify({
          ...p,
          gc: 'Stevens Construction Corp.',
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

  console.log(`\n💾 Total: imported ${imported}, skipped ${skipped} from ${projects.length} projects`);

  return { source: 'stevens', projectsFound: projects.length, imported, skipped };
}

scrape().then(result => {
  console.log(`\n✅ Stevens fetch complete. ${result.projectsFound} projects (${result.imported} new, ${result.skipped} dupes).`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
