// Quick fetch script - runs SGS + USASpending fetchers
// Reads credentials from .env.local — run from project root
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toNum(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(/[$,]/g, '')) : Number(v);
  return isFinite(n) ? n : null;
}

const KEYWORDS = [
  // TCB Metalworks
  'metal fabrication', 'structural steel', 'handrail', 'railing',
  'ornamental metal', 'steel fabrication', 'welding fabrication',
  'fencing gate', 'misc metals', 'canopy awning', 'steel door',
  'ironwork', 'guardrail', 'bollard', 'metal enclosure', 'steel platform',
  'stairs metal', 'steel railing', 'metal railing',
  // On Kaul Auto Salvage
  'vehicle towing', 'towing service', 'vehicle disposal',
  'scrap vehicle', 'salvage vehicle', 'surplus vehicle',
  'abandoned vehicle removal', 'junk vehicle',
  'auto parts recycled', 'vehicle auction',
];

async function fetchSGS() {
  let allResults = [];
  for (const kw of KEYWORDS) {
    await sleep(3000);
    const url = 'https://sam.gov/api/prod/sgs/v1/search/?index=opp&page=0&size=100&sort=-modifiedDate&q=' + encodeURIComponent(kw);
    console.log('SGS:', kw);
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log('  HTTP', res.status); continue; }
      const json = await res.json();
      const results = json._embedded?.results || [];
      console.log('  Got', results.length);
      allResults.push(...results);
    } catch(e) { console.log('  Err:', e.message); }
  }
  return allResults;
}

async function fetchUSASpending() {
  const naicsCodes = ['332312','332321','332323','332999','238120','238990'];
  let allResults = [];
  for (const naics of naicsCodes) {
    await sleep(2000);
    console.log('USASpending NAICS', naics);
    try {
      const res = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: {
            naics_codes: { require: [naics] },
            time_period: [{ start_date: '2025-10-01', end_date: '2026-04-02' }],
            award_type_codes: ['A','B','C','D']
          },
          fields: ['Award ID','Recipient Name','Award Amount','Awarding Agency','Description','Period of Performance Start Date','Place of Performance State Code','generated_internal_id'],
          limit: 25, sort: 'Award Amount', order: 'desc', page: 1
        })
      });
      if (!res.ok) { console.log('  HTTP', res.status); continue; }
      const json = await res.json();
      const results = json.results || [];
      console.log('  Got', results.length);
      allResults.push(...results.map(r => ({ ...r, _naics: naics })));
    } catch(e) { console.log('  Err:', e.message); }
  }
  return allResults;
}

async function run() {
  const { data: config } = await supabase.from('scoring_config').select('*').limit(1).single();

  // === SGS ===
  console.log('\n=== FETCHING SAM.GOV SGS ===');
  const sgsRaw = await fetchSGS();

  const seen = new Set();
  const sgsBiddable = sgsRaw.filter(r => {
    const id = r.solicitationNumber || r._id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    if (!r.isActive || r.isCanceled) return false;
    const type = r.type?.value || '';
    if (/award/i.test(type)) return false;
    return true;
  });
  console.log('SGS total:', sgsRaw.length, 'Unique biddable:', sgsBiddable.length);

  let sgsInserted = 0;
  for (const r of sgsBiddable) {
    const title = r.title || '';
    const desc = (r.descriptions?.[0]?.content || '').replace(/<[^>]*>/g, '').slice(0, 5000);
    const combined = (title + ' ' + desc).toLowerCase();
    const agency = r.organizationHierarchy?.[0]?.name || '';
    const subAgency = r.organizationHierarchy?.[1]?.name || '';
    const naics = r.naics?.[0]?.code || '';
    const place = r.placeOfPerformance ? JSON.stringify(r.placeOfPerformance).toLowerCase() : '';

    let dMin = toNum(r.award?.amount);
    let dMax = dMin;

    let score = 0;
    const signals = [];

    const nm = config.naics_codes.includes(naics);
    signals.push({ signal: 'NAICS match', delta: 30, fired: nm });
    if (nm) score += 30;

    const dv = dMax || dMin || 0;
    const ir = dv >= config.dollar_min && dv <= config.dollar_max;
    signals.push({ signal: 'Dollar range', delta: 20, fired: ir });
    if (ir) score += 20;

    const pH = config.keyword_primary.filter(k => combined.includes(k.toLowerCase()));
    signals.push({ signal: 'Primary: ' + (pH.length ? pH.join(', ') : 'none'), delta: 20, fired: pH.length > 0 });
    if (pH.length) score += 20;

    const sH = config.keyword_secondary.filter(k => combined.includes(k.toLowerCase()));
    signals.push({ signal: 'Secondary: ' + (sH.length ? sH.join(', ') : 'none'), delta: 10, fired: sH.length > 0 });
    if (sH.length) score += 10;

    const overseas = ['japan','korea','germany','overseas','foreign','oconus','far east','pacific ocean','europe','middle east','guam'];
    const isUS = !overseas.some(w => place.includes(w));
    signals.push({ signal: 'Continental US', delta: 10, fired: isUS });
    if (isUS) score += 10;

    if (combined.includes('davis-bacon') || combined.includes('certified payroll') || combined.includes('prevailing wage')) score -= 15;
    if (dv > 0 && dv < 5000) score -= 25;
    if (dv > 2000000) score -= 20;
    if (/supply[ -]only|supplies only|material supply/i.test(combined)) score -= 20;
    if (config.keyword_disqualify.filter(k => combined.includes(k.toLowerCase())).length) score -= 15;
    score = Math.max(0, Math.min(100, score));

    const poc = r.pointOfContacts?.[0];
    const { error } = await supabase.from('opportunities').upsert({
      sam_notice_id: 'sgs-' + (r.solicitationNumber || r._id),
      title,
      description: desc,
      agency,
      sub_agency: subAgency,
      naics_code: naics,
      naics_description: r.naics?.[0]?.value || '',
      dollar_min: dMin,
      dollar_max: dMax,
      posted_date: r.publishDate?.split('T')[0] || null,
      response_deadline: r.responseDateActual || r.responseDate || null,
      point_of_contact: poc?.fullName || null,
      contact_email: poc?.email || null,
      source_url: 'https://sam.gov/opp/' + r._id + '/view',
      source: 'samgov-sgs',
      raw_data: r,
      score,
      score_signals: signals,
      status: 'new',
    }, { onConflict: 'sam_notice_id', ignoreDuplicates: true });
    if (error) console.log('SGS err:', error.message.slice(0, 60));
    else sgsInserted++;
  }
  console.log('SGS inserted:', sgsInserted);

  // === USASPENDING ===
  console.log('\n=== FETCHING USASPENDING ===');
  const usaRaw = await fetchUSASpending();

  const seenUsa = new Set();
  const usaUnique = usaRaw.filter(r => {
    const id = r['Award ID'];
    if (!id || seenUsa.has(id)) return false;
    seenUsa.add(id);
    return true;
  });
  console.log('USASpending total:', usaRaw.length, 'Unique:', usaUnique.length);

  let usaInserted = 0;
  for (const r of usaUnique) {
    const amt = toNum(r['Award Amount']);
    const desc = r['Description'] || '';
    const title = desc || ('Award to ' + (r['Recipient Name'] || 'Unknown'));

    const { error } = await supabase.from('opportunities').upsert({
      sam_notice_id: 'usa-' + r['Award ID'],
      title: title.slice(0, 200),
      description: 'AWARDED CONTRACT: ' + desc + ' | Recipient: ' + (r['Recipient Name'] || '') + ' | Amount: $' + (amt ? amt.toLocaleString() : 'N/A'),
      agency: r['Awarding Agency'] || '',
      naics_code: r._naics || '',
      dollar_min: amt,
      dollar_max: amt,
      posted_date: r['Period of Performance Start Date'] || null,
      source_url: r.generated_internal_id ? 'https://www.usaspending.gov/award/' + r.generated_internal_id : null,
      source: 'usaspending',
      raw_data: r,
      score: 0,
      score_signals: [{ signal: 'Intel only - awarded contract', delta: 0, fired: true }],
      status: 'passed',
      notes: 'INTEL: Awarded contract, not an open solicitation. Use for targeting agencies and understanding market pricing.',
    }, { onConflict: 'sam_notice_id', ignoreDuplicates: true });
    if (error) console.log('USA err:', error.message.slice(0, 60));
    else usaInserted++;
  }
  console.log('USASpending inserted:', usaInserted);

  // === RESULTS ===
  const { data: top } = await supabase.from('opportunities')
    .select('title,score,agency,dollar_min,dollar_max,response_deadline,source,naics_code')
    .neq('source', 'usaspending')
    .order('score', { ascending: false })
    .limit(30);

  console.log('\n========== TOP 30 BIDDABLE OPPORTUNITIES ==========');
  top.forEach((o, i) => {
    const dl = o.response_deadline ? new Date(o.response_deadline).toLocaleDateString() : 'no deadline';
    const d = o.dollar_max ? '$' + Number(o.dollar_max).toLocaleString() : 'no $';
    console.log((i + 1) + '. [' + o.score + '] ' + o.title.slice(0, 70) + ' | ' + d + ' | ' + dl + ' | ' + o.source);
  });

  const { data: intel } = await supabase.from('opportunities')
    .select('title,dollar_max,agency')
    .eq('source', 'usaspending')
    .order('dollar_max', { ascending: false })
    .limit(10);

  console.log('\n========== TOP 10 INTEL (Recent Awards) ==========');
  intel.forEach((o, i) => {
    const d = o.dollar_max ? '$' + Number(o.dollar_max).toLocaleString() : 'no $';
    console.log((i + 1) + '. ' + o.title.slice(0, 70) + ' | ' + d + ' | ' + o.agency);
  });

  const { count } = await supabase.from('opportunities').select('*', { count: 'exact', head: true });
  console.log('\nTotal opportunities in DB:', count);
}

run().catch(e => console.error(e));
