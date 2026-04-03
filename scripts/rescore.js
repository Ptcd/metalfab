// Re-score all opportunities using the latest scoring logic
// Run from project root: node scripts/rescore.js
const { createClient } = require('@supabase/supabase-js');
const { readFileSync } = require('fs');
const { resolve } = require('path');

// Load .env.local
const envPath = resolve(__dirname, '..', '.env.local');
readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- Scoring logic (mirrors lib/scoring/engine.ts) ---

const OVERSEAS_INDICATORS = [
  'japan', 'korea', 'germany', 'overseas', 'foreign', 'oconus',
  'far east', 'pacific', 'europe', 'middle east', 'guam', 'puerto rico', 'hawaii', 'alaska',
];

const NEARBY_STATES = [
  'wisconsin', 'wi', 'illinois', 'il', 'indiana', 'in', 'michigan', 'mi',
  'iowa', 'ia', 'minnesota', 'mn', 'missouri', 'mo', 'ohio', 'oh', 'kentucky', 'ky',
];

const NEARBY_CITIES = [
  'chicago', 'milwaukee', 'madison', 'green bay', 'racine', 'kenosha',
  'rockford', 'peoria', 'springfield', 'indianapolis', 'detroit',
  'grand rapids', 'minneapolis', 'st. paul', 'des moines', 'st. louis',
  'fort wayne', 'south bend', 'gary', 'joliet', 'aurora', 'naperville',
  'great lakes', 'waukegan', 'duluth', 'lansing', 'ann arbor', 'davenport',
  'quad cities', 'dubuque', 'cedar rapids', 'champaign', 'kalamazoo',
  'bloomington', 'normal', 'elgin', 'cicero', 'evanston', 'oak park',
];

function textContains(text, keyword) {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

function isContinentalUS(place) {
  if (!place) return true;
  const lower = place.toLowerCase();
  return !OVERSEAS_INDICATORS.some(i => lower.includes(i));
}

function isNearRacine(place) {
  if (!place) return null;
  const lower = place.toLowerCase();
  if (NEARBY_CITIES.some(c => lower.includes(c))) return true;
  if (NEARBY_STATES.some(s => lower.includes(s))) return true;
  if (lower.includes(',') || /\b[a-z]{2}\b/.test(lower)) return false;
  return null;
}

function hasDrawingsOrPrints(text) {
  const lower = text.toLowerCase();
  return lower.includes('drawings') || lower.includes('prints') || lower.includes('blueprints') ||
    lower.includes('shop drawings') || lower.includes('specifications attached') ||
    lower.includes('see attached') || lower.includes('per plans') ||
    lower.includes('per specification') || lower.includes('scope of work attached') ||
    lower.includes('sow attached');
}

function scoreOpportunity(opp, config) {
  const signals = [];
  const text = [opp.title, opp.description].filter(Boolean).join(' ');

  // NAICS match: +30
  const naicsMatch = opp.naics_code && config.naics_codes.includes(opp.naics_code);
  signals.push({ signal: 'NAICS code match', delta: 30, fired: !!naicsMatch });

  // Dollar range: +20
  const dollarMax = opp.dollar_max ?? opp.dollar_min;
  const dollarInRange = dollarMax != null && dollarMax >= config.dollar_min && dollarMax <= config.dollar_max;
  signals.push({ signal: 'Dollar range match', delta: 20, fired: dollarInRange });

  // Primary keyword: +20
  const primaryHit = config.keyword_primary.some(kw => textContains(text, kw));
  signals.push({ signal: 'Primary keyword match', delta: 20, fired: primaryHit });

  // Secondary keyword: +10
  const secondaryHit = config.keyword_secondary.some(kw => textContains(text, kw));
  signals.push({ signal: 'Secondary keyword match', delta: 10, fired: secondaryHit });

  // Continental US: +10
  const continentalUS = isContinentalUS(opp.place_of_performance);
  signals.push({ signal: 'Continental US', delta: 10, fired: continentalUS });

  // Near Racine bonus: +10
  const nearbyJob = isNearRacine(opp.place_of_performance) === true;
  signals.push({ signal: 'Within driving distance of Racine, WI', delta: 10, fired: nearbyJob });

  // --- Negatives ---

  // Davis-Bacon: -15
  const davisBacon = textContains(text, 'davis-bacon') || textContains(text, 'davis bacon') ||
    textContains(text, 'certified payroll') || textContains(text, 'prevailing wage');
  signals.push({ signal: 'Davis-Bacon / certified payroll', delta: -15, fired: davisBacon });

  // Too small: -25
  const tooSmall = dollarMax != null && dollarMax < 5000;
  signals.push({ signal: 'Dollar value below $5K', delta: -25, fired: tooSmall });

  // Too large: -20
  const dollarMinVal = opp.dollar_min ?? opp.dollar_max;
  const tooLarge = dollarMinVal != null && dollarMinVal > 2000000;
  signals.push({ signal: 'Dollar value above $2M', delta: -20, fired: tooLarge });

  // Supply-only: -20
  const supplyOnly = textContains(text, 'supply only') || textContains(text, 'supply-only') ||
    textContains(text, 'supplies only') || textContains(text, 'material supply');
  signals.push({ signal: 'Supply-only (no fabrication)', delta: -20, fired: supplyOnly });

  // Cert disqualify: -15
  const certDisqualify = config.keyword_disqualify.some(kw => textContains(text, kw));
  signals.push({ signal: 'Certification not held', delta: -15, fired: certDisqualify });

  // DLA manufactured parts / military spare parts: -30
  const titleTrimmed = (opp.title || '').trim();
  const dlaParts = textContains(text, 'proposed procurement for nsn') ||
    textContains(text, 'national stock number') ||
    /^\d{2}--/.test(titleTrimmed) ||
    textContains(text, 'dla troop support') ||
    textContains(text, 'dla land and maritime') ||
    textContains(text, 'dla aviation') ||
    (/^[A-Z][A-Z ,\-/]{3,}$/.test(titleTrimmed) && titleTrimmed.length < 40) ||
    textContains(text, 'in repair/modification of');
  signals.push({ signal: 'DLA manufactured parts / NSN', delta: -30, fired: dlaParts });

  // Site visit + distance analysis
  const mentionsSiteVisit = textContains(text, 'site visit') || textContains(text, 'pre-bid conference') ||
    textContains(text, 'pre-proposal conference') || textContains(text, 'mandatory walk') ||
    textContains(text, 'mandatory inspection');
  const nearRacine = isNearRacine(opp.place_of_performance);
  const hasDrawings = hasDrawingsOrPrints(text);

  let svDelta = 0, svFired = false, svLabel = 'Location / site visit';
  if (mentionsSiteVisit && nearRacine === false && !hasDrawings) {
    svDelta = -20; svFired = true; svLabel = 'Mandatory site visit — far from Racine, WI';
  } else if (mentionsSiteVisit && nearRacine === false && hasDrawings) {
    svDelta = -5; svFired = true; svLabel = 'Site visit far away but has prints/drawings';
  } else if (!mentionsSiteVisit && nearRacine === false) {
    svDelta = -5; svFired = true; svLabel = 'Far from Racine, WI (may require travel)';
  }
  signals.push({ signal: svLabel, delta: svDelta, fired: svFired });

  // Non-fabrication: -20
  const nonFab = textContains(text, 'concrete pour') || textContains(text, 'repaving') ||
    textContains(text, 'asphalt') || textContains(text, 'roofing') ||
    textContains(text, 'roof replacement') || textContains(text, 'hvac') ||
    textContains(text, 'plumbing') || textContains(text, 'electrical contractor') ||
    textContains(text, 'painting services') || textContains(text, 'janitorial') ||
    textContains(text, 'landscaping') || textContains(text, 'mowing') ||
    textContains(text, 'demolition only') || textContains(text, 'fall protection engineering') ||
    textContains(text, 'fall protection program');
  signals.push({ signal: 'Non-fabrication primary work', delta: -20, fired: nonFab });

  const rawScore = signals.reduce((sum, s) => s.fired ? sum + s.delta : sum, 0);
  const score = Math.max(0, Math.min(100, rawScore));
  return { score, signals };
}

async function run() {
  console.log('Loading scoring config...');
  const { data: config, error: configErr } = await supabase.from('scoring_config').select('*').limit(1).single();
  if (configErr) { console.error('Config error:', configErr.message); return; }

  console.log('Loading all opportunities...');
  const { data: opps, error: oppsErr } = await supabase.from('opportunities')
    .select('id,title,description,naics_code,dollar_min,dollar_max,score,status,source,raw_data')
    .order('id');
  if (oppsErr) { console.error('Fetch error:', oppsErr.message); return; }

  // Extract place_of_performance from raw_data since the column doesn't exist yet
  for (const opp of opps) {
    const raw = opp.raw_data;
    if (!raw) { opp.place_of_performance = null; continue; }

    // SGS format: placeOfPerformance is array of { city, state, country }
    if (raw.placeOfPerformance && Array.isArray(raw.placeOfPerformance)) {
      const loc = raw.placeOfPerformance[0];
      if (loc) {
        opp.place_of_performance = [loc.city, loc.state, loc.country].filter(Boolean).join(', ');
        continue;
      }
    }
    // SGS format: organizationHierarchy with office address
    if (raw.organizationHierarchy && Array.isArray(raw.organizationHierarchy)) {
      const office = raw.organizationHierarchy.find(o => o.address);
      if (office && office.address) {
        opp.place_of_performance = [office.address.city, office.address.state, office.address.country].filter(Boolean).join(', ');
        continue;
      }
    }
    // Official SAM.gov format: placeOfPerformance object
    if (raw.placeOfPerformance && typeof raw.placeOfPerformance === 'object' && !Array.isArray(raw.placeOfPerformance)) {
      const loc = raw.placeOfPerformance;
      opp.place_of_performance = [loc.city, loc.state, loc.country].filter(Boolean).join(', ');
      continue;
    }
    // USASpending: Place of Performance State Code
    if (raw['Place of Performance State Code']) {
      opp.place_of_performance = raw['Place of Performance State Code'];
      continue;
    }
    opp.place_of_performance = null;
  }

  console.log(`Re-scoring ${opps.length} opportunities...`);

  let changed = 0;
  let autoPass = 0;

  for (const opp of opps) {
    // Skip usaspending intel records
    if (opp.source === 'usaspending') continue;

    const result = scoreOpportunity(opp, config);

    // Auto-pass DLA parts and non-fabrication work
    const dlaSig = result.signals.find(s => s.signal.includes('DLA') && s.fired);
    const nonFabSig = result.signals.find(s => s.signal.includes('Non-fabrication') && s.fired);
    let newStatus = undefined;
    let notes = undefined;

    if (dlaSig && opp.status === 'new') {
      newStatus = 'passed';
      notes = 'Auto-passed: DLA manufactured parts / NSN procurement';
      autoPass++;
    } else if (nonFabSig && result.score < 30 && opp.status === 'new') {
      newStatus = 'passed';
      notes = 'Auto-passed: Non-fabrication primary work scope';
      autoPass++;
    }

    if (result.score !== opp.score || newStatus) {
      const update = { score: result.score, score_signals: result.signals };
      if (newStatus) { update.status = newStatus; update.notes = notes; }

      const { error } = await supabase.from('opportunities').update(update).eq('id', opp.id);
      if (error) {
        console.log(`  Error updating ${opp.id}: ${error.message}`);
      } else {
        changed++;
        if (result.score !== opp.score) {
          console.log(`  ${opp.title.slice(0, 60)} | ${opp.score} -> ${result.score}${newStatus ? ' [AUTO-PASSED]' : ''}`);
        }
      }
    }
  }

  console.log(`\nDone! ${changed} opportunities updated, ${autoPass} auto-passed.`);

  // Show new top 20
  const { data: top } = await supabase.from('opportunities')
    .select('title,score,agency,place_of_performance,response_deadline,source')
    .eq('status', 'new')
    .order('score', { ascending: false })
    .limit(20);

  console.log('\n========== TOP 20 NEW OPPORTUNITIES (re-scored) ==========');
  if (top) {
    top.forEach((o, i) => {
      const dl = o.response_deadline ? new Date(o.response_deadline).toLocaleDateString() : 'no deadline';
      const loc = o.place_of_performance ? o.place_of_performance.slice(0, 30) : 'unknown';
      console.log(`${i + 1}. [${o.score}] ${o.title.slice(0, 65)} | ${loc} | ${dl}`);
    });
  }
}

run().catch(e => console.error(e));
