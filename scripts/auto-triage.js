// Auto-triage: applies pattern-matching rules to auto-pass obvious non-fits
// This runs as a Node script OUTSIDE of Claude's context window
// Only survivors need human/AI review
//
// Run: node scripts/auto-triage.js

const { createClient } = require('@supabase/supabase-js');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const envPath = resolve(__dirname, '..', '.env.local');
readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
// TRIAGE RULES — everything here runs without Claude context
// ============================================================

// DLA catalog-style ALL CAPS titles: "PUMP,ROTARY", "VALVE,GATE", "CIRCUIT CARD ASSEMB"
function isDLACatalogTitle(title) {
  const t = title.trim();
  return /^[A-Z][A-Z ,\-/]{3,}$/.test(t) && t.length < 40;
}

// FSC-coded DLA title: "53--SCREW,CAP" "48--VALVE,GATE"
function isFSCTitle(title) {
  return /^\d{2}--/.test(title.trim());
}

// Title prefixed with classification codes like "6515--", "7195--", "4110--"
function isClassCodeTitle(title) {
  return /^\d{4}--/.test(title.trim());
}

// Check if text matches patterns that are definitely NOT metal fabrication
function isDefinitelyNotMetalFab(title, desc) {
  const text = (title + ' ' + (desc || '')).toLowerCase();

  const notMetalFab = [
    // IT / Software / Electronics
    'software', 'license renewal', 'data platform', 'cloud support', 'cisco network',
    'vmware', 'it training', 'marketing platform', 'web-based', 'ediscovery',
    'fleet management system', 'cctv', 'vms', 'intrusion detection', 'alarm system',
    'alarm monitoring', 'windows 10 upgrade', 'windows upgrade',
    // Medical / Lab
    'surgical instrument', 'steriliz', 'hematology', 'reagent', 'spectrometer',
    'specimen processor', 'radiopharmaceutic', 'sleep stud', 'polysomnography',
    'x-ray technician', 'ct/x-ray', 'mammogra', 'nuclear magnetic resonance',
    'ball mill mixer', 'confocal', 'lab supplies',
    // Food / Lodging / Services
    'food delivery', 'mess attendant', 'lodging & feeding', 'catering',
    'janitorial', 'custodial', 'laundry', 'pest control', 'bat removal',
    'religious education', 'chaplain', 'interpretive saddle', 'horseback',
    'vending operations', 'tent rental', 'tables, chairs',
    // Vehicles / Aircraft / Ships
    'aircraft repaint', 'nose radome', 'helicopter', 'f-16', 'f-22', 'f-35',
    'c-5 valve', 'c-130', 'b-52', 'b-2 ', 'cv-22', 'rocket motor',
    'ejection seat', 'canopy jettison', 'dipole magnet',
    'uss ', 'docking selected', 'ship availability', 'vessel yard',
    'stern tube', 'propeller sleeve',
    // Raw materials only
    'round bar', 'aluminum for signs', 'sphagnum moss', 'casting articulated concrete',
    'scrap term contract', 'demil a mixed metals', 'demil a stainless',
    // Construction too large or wrong scope
    'child development center', 'hazardous storage facility', 'rf hangar',
    'multiple award construction contract', 'macc', 'design-build services for the bridge',
    'missile munitions distribution', 'rocket missile maintenance',
    // Medical equipment
    'refrigerator', 'dehydrator unit', 'fume hood', 'sterilization units',
    // Misc not relevant
    'ion nitride', 'gage block', 'indicator tester', 'cron', 'ride control',
    'sediment pump', 'fire alarm', 'rooftop unit', 'air filter replacement',
    'washer/disinfector', 'door lock', 'elevator upgrade', 'siding replacement',
    'trail maintenance', 'atv trail', 'snow damage repair',
    'pallet stacker', 'storage container', 'shipping container',
    'tiny home', 'picnic pavilion',
    'training system increment', 'combat training',
    'lead generation', 'data analytics', 'music and radio',
    'lease of office', 'leasing opportunity',
    // BidNet common non-metal-fab categories
    'telecom', 'voice services', 'modern services', 'phone system',
    'dental', 'vision benefit', 'dental benefit', 'dental plan',
    'chrome device', 'chromebook', 'laptop', 'computer',
    'meal plan', 'food service', 'dining', 'cafeteria',
    'athletic uniform', 'uniform', 'apparel',
    'carpet replacement', 'carpet install', 'flooring',
    'urinalysis', 'urine', 'drug testing', 'laboratory sample',
    'turbo pump', 'vacuum pump', 'hipace',
    'natural areas management', 'forestry', 'tree trimming', 'tree removal',
    'serology', 'analyzer', 'high-throughput',
    'sidewalk replacement', 'sidewalk repair', 'concrete sidewalk',
    'lead service replacement', 'lead pipe', 'watermain',
    'bridge replacement', 'bridge construction', 'bridge repair',
    'storm drainage', 'subdrain', 'stormwater', 'swm retrofit',
    'traffic control', 'mot ', 'mot/', 'maintenance of traffic',
    'crime lab', 'crime laboratory', 'forensic',
    'equipment rental', 'transformer test', 'test set rental',
    'custodial service', 'cleaning service', 'janitor',
    'current-production model', // vague procurement for vehicles/equip
    'circuit card assembly', 'circuit board', 'pcb assembly',
    'insurance', 'benefit management', 'health plan', 'wellness',
    'landscaping', 'lawn care', 'mowing', 'snow plow', 'snow removal',
    'painting', 'paint service', 'interior painting', 'exterior painting',
    'roofing', 'roof replacement', 'roof repair', 'shingle',
    'hvac', 'air condition', 'heating', 'boiler repair', 'chiller',
    'plumbing', 'plumber', 'pipe repair',
    'electrical', 'electrician', 'wiring', 'switchgear',
    'paving', 'asphalt', 'resurfacing', 'road repair', 'pothole',
    'consulting', 'consultant', 'advisory', 'study',
    'audit', 'accounting', 'financial advisor',
    'legal service', 'attorney', 'law firm',
    'advertising', 'marketing', 'public relation', 'media buy',
    'printing', 'print service', 'copy service',
    'towing', 'tow service', 'vehicle tow',
    'ambulance', 'ems ', 'paramedic',
    'demolition', 'abatement', 'asbestos',
    'moving service', 'relocation service',
    'security guard', 'security officer', 'armed guard',
    'courier', 'delivery service', 'mail service',
    // More BidNet common non-metal-fab
    'surveillance camera', 'camera project', 'dvr', 'cctv',
    'digital signage', 'signage and banner',
    'power supply', 'programmable dc', 'ups replacement',
    'bath tissue', 'toilet paper', 'paper towel', 'tissue',
    'bedding for laboratory', 'laboratory animal', 'animal bedding',
    'recycling education', 'education program',
    'vehicle', 'bronco', 'ford ', 'suv ', 'sedan ', '4x4',
    'window washing', 'pressure washing', 'window cleaning',
    'suicide prevention', 'mental health', 'counseling',
    'sanitary sewer', 'sewer rehabilitation', 'sewer repair', 'manhole',
    'water main', 'water treatment', 'water department', 'watermain',
    'road improvement', 'road program', 'road reconstruction', 'sterk road',
    'pavement maintenance', 'pavement marking', 'mill and overlay',
    'joint and crack', 'crack filling', 'crack seal',
    'concrete restoration', 'concrete repair', 'concrete sidewalk', 'concrete bid',
    'sidewalk improvement', 'sidewalk replacement',
    'bridge maintenance', 'bridge preventative', 'bridge sealing',
    'parking lot', 'parking lot replacement',
    'gutter replacement', 'roof replacement', 'roof ', 'gutter',
    'plant beautification', 'landscap',
    'fish feed', 'catfish', 'ammo', 'sniper',
    'court reporting', 'reporting service',
    'sound, video', 'lighting equipment', 'concert',
    'elevator replacement', 'elevator',
    'kayak', 'boat launch', 'canoe',
    'concession', 'food service',
    'hot water tank', 'powerhouse hot water',
    'impound parking', 'parking lot project',
    'b-box replacement', 'service cleanout',
    'charging program', 'ev charging', 'electric vehicle charg',
    'data security', 'data review', 'on-site review',
    'commissioning service', 'commissioning agent',
    'site utility', 'site utilities',
    'piles & caissons', 'caisson', 'pile driving',
    'floor sealer', 'floor coating',
    'rough carpentry', 'carpentry',
    'resteel', 'rebar', 'reinforcing steel install',
    'surveying', 'survey service', 'land survey',
    'drainage pump', 'pumping station', 'pump station',
    'voltage transformer', 'coupling capacitor',
    'voice and data circuit', 'data circuit', 'leased line',
    'door replacement', 'architectural service',
    'screener', 'sel universal', 'window treatment',
    'gymnasium window',
    'physical readiness', 'fitness test',
    'aircraft tug', 'ground support',
    'drop off site', 'transfer station',
    'interior renewal', 'palo alto',
    'energy product', 'window for the bec',
    'dishwasher', 'kitchen',
    'operations office update',
    // Round 3 BidNet cleanup
    'masonry', 'brick', 'tiling', 'tile install', 'tile work',
    'zoning code', 'zoning map', 'code update',
    'invasive species', 'weed control', 'herbicide',
    'precision measurement', 'measurement equipment', 'calibration',
    'ethernet', 'commercial lease on', 'iqo contract',
    'aeration improvement', 'wwtp', 'wastewater treatment',
    'professional engineer service', 'engineering service',
    'quality control', 'pccp',
    'hot water boiler', 'boiler', 'storage tank and associated',
    'weatherization', 'insulation',
    'football equipment', 'reconditioning', 'recertification',
    'toilet partition', 'bathroom accessor', 'sink valve', 'toilet',
    'signage', 'sign ', // careful with this one
    'exempt notice', 'exempt procurement', 'procurement report',
    'scale eastbound', 'metro ethernet',
    'pipette calibration', 'calibration',
    'oracle maintenance', 'oracle', 'sap ',
    'de-icer', 'deicer', 'salt storage',
    'handheld radio', 'wildland fire', 'firefighting',
    'fire system', 'fire suppression', 'ansul',
    'musical instrument', 'instrument repair',
    'fire apparatus', 'aerial fire', 'fire truck',
    'rent reasonableness',
    'deconstruction', 'power house deconstruction',
    'streetlight repair', 'streetlight', 'cable replace',
    'water & sewer connection', 'sewer connection',
    'runway removal', 'runway',
    'communications recorder', 'recorder',
    'notetaking', 'note taking', 'student disabilities',
    'audio-visual', 'audio visual', 'av system',
    'insulated glass', 'glass unit replacement', 'glass replacement',
    'battery-electric', 'electric bus', 'transit bus',
    'plaster repair', 'decorative plaster',
    'jail cooling', 'cooling system',
    'pavilion project', 'park pavilion',
    'street maintenance', 'street program',
    'reconstruction', // broad but catches road/street reconstruction
    'sewer',
  ];

  return notMetalFab.some(pattern => text.includes(pattern));
}

// Check if sole source to another company
function isSoleSource(title, desc) {
  const text = (title + ' ' + (desc || '')).toLowerCase();
  return (
    (text.includes('sole source') && !text.includes('sources sought')) ||
    text.includes('intent to sole source') ||
    text.includes('notice of intent to award') ||
    text.includes('restricted to qualified source') ||
    /restricted to .+ \(cage/i.test(text)
  );
}

// Check if overseas
function isOverseas(title, desc, rawData) {
  const text = (title + ' ' + (desc || '')).toLowerCase();
  const overseas = ['guatemala', 'cambodia', 'phnom penh', 'madagascar', 'antananarivo',
    'india', 'new delhi', 'south africa', 'pretoria', 'japan', 'korea', 'germany',
    'oconus', 'foreign', 'overseas', 'apo, ae'];

  if (overseas.some(loc => text.includes(loc))) return true;

  // Check raw_data location
  if (rawData?.placeOfPerformance) {
    const pop = Array.isArray(rawData.placeOfPerformance) ? rawData.placeOfPerformance[0] : rawData.placeOfPerformance;
    const country = (pop?.country || '').toUpperCase();
    if (country && country !== 'USA' && country !== 'US' && country !== '') return true;
  }

  return false;
}

// Check if it's a gate attendant (person) not a metal gate
function isGateAttendant(title) {
  return /gate attendant/i.test(title);
}

// Check for expired deadline
function isExpired(deadline) {
  if (!deadline) return false;
  return new Date(deadline) < new Date();
}

// Check if this looks like a campground/park services job
function isParkServices(title, desc) {
  const text = (title + ' ' + (desc || '')).toLowerCase();
  return text.includes('campground') || text.includes('park ranger') ||
    text.includes('guided interpretive') || text.includes('saddle and pack');
}

// ============================================================
// POSITIVE SIGNALS — things that suggest metal fab
// ============================================================

function looksLikeMetalFab(title, desc) {
  const text = (title + ' ' + (desc || '')).toLowerCase();
  const metalFabIndicators = [
    'handrail', 'hand rail', 'railing', 'stair', 'guardrail', 'guard rail',
    'bollard', 'metal gate', 'security gate', 'vehicle gate', 'slide gate',
    'swing gate', 'roll up gate', 'miter gate', 'spillway gate', 'gate fabricat',
    'metal fence', 'security fence', 'chain link', 'ornamental metal', 'ornamental iron',
    'structural steel fabricat', 'steel fabricat', 'metal fabricat', 'welding',
    'misc metals', 'miscellaneous metals', 'canopy', 'awning', 'metal platform',
    'steel platform', 'ladder', 'grating', 'metal door', 'hollow metal',
    'roll up door', 'rollup door', 'overhead door', 'metal ramp', 'ada ramp',
    'steel repair', 'weld repair', 'ironwork', 'wrought iron',
    'hatch', 'watertight', 'metal roof', 'steel pole', 'pole foundation',
    'metal stair', 'fire escape', 'steel beam', 'structural steel',
    'misc. metal', 'misc metal', 'miscellaneous metal',
    'metal panel', 'metal deck', 'steel deck', 'metal cladding',
    'dumpster enclosure', 'trash enclosure', 'equipment screen',
    'pipe support', 'pipe hanger', 'pipe rack',
    'fences & gates', 'fences and gates', 'fence and gate',
    'spreader beam', 'lifting beam',
    'columbari', // columbarium/columbaria - metal/stone memorial
    'tap box', // electrical utility metal box
    'monument sign', // metal sign fabrication
  ];

  return metalFabIndicators.some(indicator => text.includes(indicator));
}

// ============================================================
// POSITIVE SIGNALS — things that suggest auto salvage / scrap yard
// ============================================================

function looksLikeSalvageYard(title, desc) {
  const text = (title + ' ' + (desc || '')).toLowerCase();
  const salvageIndicators = [
    'towing service', 'tow service', 'tow contract', 'vehicle tow',
    'impound', 'vehicle impound',
    'vehicle disposal', 'vehicle removal', 'junk vehicle', 'junked vehicle',
    'abandon vehicle', 'abandoned vehicle',
    'scrap metal', 'scrap vehicle', 'scrap car', 'scrap auto',
    'salvage vehicle', 'salvage auto', 'auto salvage',
    'surplus vehicle', 'sale of surplus', 'fleet disposal',
    'vehicle auction', 'auto auction',
    'recycled auto part', 'used auto part', 'recycled part',
    'auto part', 'vehicle part',
    'crushing', 'vehicle crushing', 'car crusher',
    'fleet maintenance', 'vehicle maintenance',
    'body shop', 'auto body', 'collision repair',
  ];

  return salvageIndicators.some(indicator => text.includes(indicator));
}

// ============================================================
// MAIN TRIAGE LOGIC
// ============================================================

async function run() {
  console.log('Loading new opportunities...');
  const { data: opps, error } = await supabase.from('opportunities')
    .select('id,title,description,response_deadline,raw_data,score,source,naics_code,agency')
    .eq('status', 'new')
    .order('score', { ascending: false });

  if (error) { console.error('Error:', error.message); return; }
  if (!opps || opps.length === 0) {
    console.log('No new opportunities to triage.');
    return;
  }

  console.log(`Found ${opps.length} new opportunities to triage.\n`);

  let passed = 0;
  let kept = 0;
  let autoReview = 0;
  const survivors = [];
  const reviewed = [];

  for (const opp of opps) {
    const title = opp.title || '';
    const desc = (opp.description || '').replace(/<[^>]*>/g, '').slice(0, 5000);
    let reason = null;

    // Check auto-pass rules in priority order
    if (isExpired(opp.response_deadline)) {
      reason = 'Auto-passed: Deadline expired';
    } else if (isDLACatalogTitle(title)) {
      reason = 'Auto-passed: DLA catalog-style part title';
    } else if (isFSCTitle(title)) {
      reason = 'Auto-passed: FSC-coded DLA title';
    } else if (isClassCodeTitle(title)) {
      reason = 'Auto-passed: Classification-coded title (likely commodity)';
    } else if (isGateAttendant(title)) {
      reason = 'Auto-passed: Gate attendant (person, not metal gate)';
    } else if (isSoleSource(title, desc)) {
      reason = 'Auto-passed: Sole source to specific vendor';
    } else if (isOverseas(title, desc, opp.raw_data)) {
      reason = 'Auto-passed: Overseas location';
    } else if (isParkServices(title, desc)) {
      reason = 'Auto-passed: Park/campground services';
    } else if (isDefinitelyNotMetalFab(title, desc)) {
      reason = 'Auto-passed: Not metal fabrication work';
    }

    // Check positive signals BEFORE auto-pass (salvage bids might match "not metal fab" patterns)
    const isMetalFab = looksLikeMetalFab(title, desc);
    const isSalvage = looksLikeSalvageYard(title, desc);

    if (isMetalFab || isSalvage) {
      // Positive match — move to reviewing with business tag
      const biz = isMetalFab ? 'metalfab' : 'salvage';
      const label = isMetalFab ? 'metal fab' : 'salvage yard';
      const note = `Auto-review: Title/description contains ${label} keywords. Score: ${opp.score}. Needs human/AI deep review.`;
      const updateData = { status: 'reviewing', notes: note };
      // Only set business column if it exists (migration may not have run yet)
      try {
        await supabase.from('opportunities')
          .update({ ...updateData, business: biz })
          .eq('id', opp.id);
      } catch (e) {
        await supabase.from('opportunities')
          .update(updateData)
          .eq('id', opp.id);
      }
      autoReview++;
      reviewed.push({ ...opp, business: biz });
      console.log(`  REVIEW [${biz}]: ${title.slice(0, 50)} [${opp.score}]`);
    } else if (reason) {
      // Auto-pass
      await supabase.from('opportunities')
        .update({ status: 'passed', notes: reason })
        .eq('id', opp.id);
      passed++;
      console.log(`  PASS: ${title.slice(0, 55)} → ${reason.slice(0, 40)}`);
    } else {
      // Survivor — needs Claude review (kept as "new")
      kept++;
      survivors.push(opp);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`TRIAGE COMPLETE`);
  console.log(`  Total processed: ${opps.length}`);
  console.log(`  Auto-passed:     ${passed}`);
  console.log(`  Auto-reviewing:  ${autoReview}`);
  console.log(`  Need AI review:  ${kept}`);
  console.log('='.repeat(60));

  if (reviewed.length > 0) {
    console.log('\nAUTO-MOVED TO REVIEWING:');
    reviewed.forEach((o, i) => {
      const dl = o.response_deadline ? new Date(o.response_deadline).toLocaleDateString() : 'no deadline';
      console.log(`  ${i + 1}. [${o.score}] ${o.title.slice(0, 65)} | ${dl}`);
    });
  }

  if (survivors.length > 0) {
    console.log('\nNEED CLAUDE REVIEW (open SAM.gov and read SOW):');
    survivors.forEach((o, i) => {
      const dl = o.response_deadline ? new Date(o.response_deadline).toLocaleDateString() : 'no deadline';
      console.log(`  ${i + 1}. [${o.score}] ${o.title.slice(0, 65)} | ${dl}`);
      console.log(`     ${o.source_url || 'no URL'}`);
    });
  } else {
    console.log('\nNo opportunities need Claude review — all triaged by rules.');
  }

  // Output JSON summary for Claude to consume if piped
  const summary = {
    total: opps.length,
    passed,
    autoReview,
    needsReview: kept,
    survivors: survivors.map(o => ({
      id: o.id,
      title: o.title,
      score: o.score,
      deadline: o.response_deadline,
      agency: o.agency,
    })),
  };
  console.log('\n__TRIAGE_JSON__' + JSON.stringify(summary));
}

run().catch(e => console.error(e));
