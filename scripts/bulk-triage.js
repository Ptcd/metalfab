// Bulk triage remaining "new" opportunities
const { createClient } = require('@supabase/supabase-js');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const envPath = resolve(__dirname, '..', '.env.local');
readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const passRules = [
  // Naval/military equipment - not metal fab
  { pattern: '%Steam Catapult Compressor%', note: 'Not metal fab: specialized naval compressor' },
  { pattern: '%YC-1588%', note: 'Not metal fab: vessel maintenance in WA' },
  { pattern: '%USS ST LOUIS%', note: 'Not metal fab: Navy ship docking - needs shipyard' },
  { pattern: '%USS BOXER%', note: 'Not metal fab: Navy ship availability - needs shipyard' },
  { pattern: '%Canopy Jettison Rocket Motor%', note: 'Not metal fab: explosive rocket motors' },
  { pattern: '%Missile Munitions Distribution%', note: 'Not metal fab: huge building construction' },
  { pattern: '%Rocket Missile Mai%', note: 'Not metal fab: missile maintenance facility' },
  { pattern: '%F-16 Regulating Valve%', note: 'Not metal fab: restricted to Honeywell' },
  { pattern: '%C-5 Valve Assembly%', note: 'Not metal fab: restricted to Hydro-Aire' },
  { pattern: '%Fabrication of Stern Tube%', note: 'Not metal fab: stern tube in Japan' },
  { pattern: '%S.S.S. CLUTCH%', note: 'Not metal fab: specialized clutch' },
  { pattern: '%C-130 Nose Radome%', note: 'Not metal fab: sole source to Lockheed' },
  { pattern: '%SPRRA1%', note: 'Not metal fab: aircraft parts' },
  { pattern: '%B-52J CERP%', note: 'Not metal fab: aircraft modification kits' },
  { pattern: '%POLAR STAR CRANE%', note: 'Not metal fab: crane system for icebreaker' },
  { pattern: '%OEM Siemens Energy Motor%', note: 'Not metal fab: sole source motor' },
  { pattern: '%Slip Ring Assembly%', note: 'Not metal fab: electronic repair, sole source' },
  { pattern: '%FedTribe%RQ-21A%', note: 'Not metal fab: UAV support' },
  { pattern: '%Tactical Combat Training%', note: 'Not metal fab: military training system' },
  { pattern: '%Parts for Ride Control%', note: 'Not metal fab: ship parts' },
  { pattern: '%REPAIR 1 UNIT NSN%', note: 'Not metal fab: aircraft valve repair' },
  { pattern: '%B-2 Access Control%', note: 'Not metal fab: electronic security' },
  { pattern: '%Ready Service Lockers%', note: 'Not metal fab: locker supply in WA' },
  { pattern: '%High Density Storage System%', note: 'Not metal fab: storage system' },
  { pattern: '%NSN: 1560-015609961%', note: 'Not metal fab: aircraft parts sole source' },

  // Buildings/construction not metal fab
  { pattern: '%Child Development Center%', note: 'Not metal fab: building construction' },
  { pattern: '%P001U Hazardous Storage%', note: 'Not metal fab: full building construction' },
  { pattern: '%B-21 Radio Frequency%Hangar%', note: 'Not metal fab: hangar construction' },
  { pattern: '%Johnson Space Center%Construction%', note: 'Not metal fab: huge construction MACC' },
  { pattern: '%Multiple Award Construction%Aviano%', note: 'Not metal fab: construction in Italy' },

  // Overseas
  { pattern: '%GUATEMALA%Checkpoint%', note: 'Not metal fab: overseas Guatemala' },
  { pattern: '%Demolition of Cavity Wall%', note: 'Not metal fab: demolition in India' },
  { pattern: '%Custom Pallet stacker%', note: 'Not metal fab: South Africa' },
  { pattern: '%Wireless Intrusio%Phnom Penh%', note: 'Not metal fab: security in Cambodia' },
  { pattern: '%Central Alarm Monitoring%Antananarivo%', note: 'Not metal fab: alarm in Madagascar' },

  // Services/IT/medical
  { pattern: '%R602--UPS%', note: 'Not metal fab: UPS delivery sole source' },
  { pattern: '%L.S Starrett Gage Block%', note: 'Not metal fab: measurement equipment' },
  { pattern: '%ADVANTOR VMS%', note: 'Not metal fab: CCTV system' },
  { pattern: '%Mirrors,%Shelves,%Shades%', note: 'Not metal fab: VA furniture in Maine' },
  { pattern: '%VA LONG BEACH%REFRIGERATORS%', note: 'Not metal fab: refrigerators' },
  { pattern: '%Steel Storage Containers%Red Rock%', note: 'Not metal fab: shipping containers NM' },
  { pattern: '%REMOVAL AND REMEDIATION OF BATS%', note: 'Not metal fab: bat removal' },
  { pattern: '%DEMIL A MIXED METALS SCRAP%', note: 'Not metal fab: scrap disposal' },
  { pattern: '%DEMIL A STAINLESS STEEL SCRAP%', note: 'Not metal fab: scrap disposal' },
  { pattern: '%Outdoor Packaged DX Rooftop%', note: 'Not metal fab: HVAC unit' },
  { pattern: '%Surgical Grade Instruments%', note: 'Not metal fab: medical instruments' },
  { pattern: '%VMware vSphere Training%', note: 'Not metal fab: IT training' },
  { pattern: '%Mobile Vending Operations%', note: 'Not metal fab: vending lease' },
  { pattern: '%FWS OFFICE OF LAW%DATA PL%', note: 'Not metal fab: IT platform' },
  { pattern: '%Linkage, Review, and Cloud%', note: 'Not metal fab: IT cloud' },
  { pattern: '%Lead Generation Marketing%', note: 'Not metal fab: marketing' },
  { pattern: '%SEDIMENT PUMPS%', note: 'Not metal fab: pumps' },
  { pattern: '%Physical Access Control System%', note: 'Not metal fab: electronic security' },
  { pattern: '%NEARNG SVCTE%EXEVAL%', note: 'Not metal fab: military training' },
  { pattern: '%Vindicator IDS/ACS%', note: 'Not metal fab: IT upgrade' },
  { pattern: '%Sterilizing Units%', note: 'Not metal fab: medical equipment' },
  { pattern: '%GPS Iridum Antennas%', note: 'Not metal fab: antennas' },
  { pattern: '%PICNIC PAVILION%', note: 'Not metal fab: wood pavilion' },
  { pattern: '%Inactive Duty Training Lodging%', note: 'Not metal fab: lodging' },
  { pattern: '%Copan Wasp Specimen%', note: 'Not metal fab: lab equipment' },
  { pattern: '%Rustici License Renewal%', note: 'Not metal fab: software' },
  { pattern: '%PIP-II Dipole Magnets%', note: 'Not metal fab: physics magnets' },
  { pattern: '%Ion Nitride Components%', note: 'Not metal fab: coating services' },
  { pattern: '%Lake Sonoma Sewage%', note: 'Not metal fab: sewage services' },
  { pattern: '%Aluminum for Signs%', note: 'Not metal fab: raw material' },
  { pattern: '%Cheyenne Mountain%Fire Alarm%', note: 'Not metal fab: fire alarm' },
  { pattern: '%Sphagnum Moss%', note: 'Not metal fab: moss' },
  { pattern: '%Air Filter Replacement%', note: 'Not metal fab: HVAC filters' },
  { pattern: '%CT/X-ray Technician%', note: 'Not metal fab: medical staffing' },
  { pattern: '%Polysomnography Sleep%', note: 'Not metal fab: sleep studies' },
  { pattern: '%Boat and Mobility Platform%', note: 'Not metal fab: boat maintenance' },
  { pattern: '%Food Delivery Services%', note: 'Not metal fab: food delivery' },
  { pattern: '%Elevated Work Platform%Maintenance%', note: 'Not metal fab: lift maintenance' },
  { pattern: '%WTGB Officer Stateroom%', note: 'Not metal fab: ship furniture' },
  { pattern: '%600MHz Nuclear Magnetic%', note: 'Not metal fab: lab spectrometer' },
  { pattern: '%Nano Ball Mill Mixer%', note: 'Not metal fab: lab equipment' },
  { pattern: '%CNC Plasma Cutters%', note: 'Not metal fab: equipment purchase' },
  { pattern: '%Hematology and Reagents%', note: 'Not metal fab: medical supplies' },
  { pattern: '%Cisco Network Equipment%', note: 'Not metal fab: IT equipment' },
  { pattern: '%Mental Health Over Door Alarm%', note: 'Not metal fab: alarm system' },
  { pattern: '%Protestant%Religious Education%', note: 'Not metal fab: religious ed' },
  { pattern: '%Airshow 2026 Tents%', note: 'Not metal fab: tent rental' },
  { pattern: '%Airpark Aircraft Repaint%', note: 'Not metal fab: aircraft painting' },
  { pattern: '%Gregory Hall Fume Hood%', note: 'Not metal fab: fume hood repairs' },
  { pattern: '%Building 51 Painting%', note: 'Not metal fab: painting/flooring' },
  { pattern: '%Guided Interpretive Saddle%', note: 'Not metal fab: horseback riding' },
  { pattern: '%Tatanka Hotshot%Siding%', note: 'Not metal fab: siding replacement' },
  { pattern: '%Access Control System PR Army%', note: 'Not metal fab: security in PR' },
  { pattern: '%Rental Equipment%', note: 'Not metal fab: equipment rental' },
  { pattern: '%Alvin Bush Dam Rock Wall%', note: 'Not metal fab: rock wall civil engineering' },
  { pattern: '%Saratoga National Park%', note: 'Not metal fab: cannon carriage reproduction' },
  { pattern: '%Gate Attendant%Services%', note: 'Not metal fab: campground attendant (person)' },
  { pattern: '%Washer/Disinfectors removal%', note: 'Not metal fab: medical equipment install' },
  { pattern: '%Fire Door Repair%', note: 'Fire door work in TX, too far' },
  { pattern: '%LEVEL 1 Round Bar%', note: 'Not metal fab: raw material procurement' },
  { pattern: '%Strainer%', note: 'Not metal fab: Navy part' },
  { pattern: '%Fiba Technologies%', note: 'Not metal fab: sole source gas cylinders' },
  { pattern: '%Rosebud Quarters Fencing%', note: 'Residential fencing in SD' },
  { pattern: '%Rocky Gap ATV Trail%', note: 'Trail maintenance in PA' },
  { pattern: '%InPro Stainless Steel Handrails%', note: 'Brand-name only, California' },
  { pattern: '%Bridgeport Warehouse Snow Damage%', note: 'Building repair in CA' },

  // Possible interest but wrong type
  { pattern: '%West Point Spillway Gate Painting%', note: 'Painting only, not fabrication. Alabama.' },
  { pattern: '%Tiny Home%', note: 'Not metal fab: tiny home construction' },
];

// Things to move to reviewing
const reviewRules = [
  { pattern: '%NIST Sitewide Handrail Project%', note: 'REVIEW: NIST handrail project in Boulder, CO. Far from Racine but handrails are core TCB work. Due 5/6. Need to check if can bid off specs/drawings.' },
  { pattern: '%STATION ATLANTIC CITY EXTERNAL DOOR REPLACEMENT%', note: 'REVIEW: 10 exterior door and frame replacements at Coast Guard station in NJ. Metal doors/frames is TCB work. Due 5/1.' },
  { pattern: '%Cherry Creek Dam%Rehab Gate Stems%', note: 'REVIEW: Gate stem rehabilitation at Cherry Creek Dam, CO. Metal fab/machining work. Due 4/10.' },
  { pattern: '%Steel Pole Foundations%', note: 'REVIEW: Steel pole foundations IDIQ for power lines. Structural steel work. Due 5/4.' },
  { pattern: '%HATCH,FL,WT,24"X24"%', note: 'REVIEW: Navy watertight hatch fabrication. This is metal fab. Due 4/13.' },
];

async function run() {
  let passCount = 0;
  for (const rule of passRules) {
    const { data } = await supabase.from('opportunities')
      .select('id,title')
      .eq('status', 'new')
      .ilike('title', rule.pattern);

    for (const opp of (data || [])) {
      const { error } = await supabase.from('opportunities')
        .update({ status: 'passed', notes: rule.note })
        .eq('id', opp.id);
      if (!error) {
        passCount++;
        console.log('PASS: ' + opp.title.slice(0, 55));
      }
    }
  }
  console.log('\nPassed: ' + passCount);

  let reviewCount = 0;
  for (const rule of reviewRules) {
    const { data } = await supabase.from('opportunities')
      .select('id,title')
      .eq('status', 'new')
      .ilike('title', rule.pattern);

    for (const opp of (data || [])) {
      const { error } = await supabase.from('opportunities')
        .update({ status: 'reviewing', notes: rule.note })
        .eq('id', opp.id);
      if (!error) {
        reviewCount++;
        console.log('REVIEW: ' + opp.title.slice(0, 55));
      }
    }
  }
  console.log('Moved to reviewing: ' + reviewCount);

  // Show remaining
  const { data: remaining } = await supabase.from('opportunities')
    .select('id,title,score,agency,response_deadline')
    .eq('status', 'new')
    .order('score', { ascending: false });

  console.log('\n===== REMAINING NEW (' + remaining.length + ') =====');
  remaining.forEach((o, i) => {
    const dl = o.response_deadline ? new Date(o.response_deadline).toLocaleDateString() : 'no deadline';
    console.log((i + 1) + '. [' + o.score + '] ' + o.title.slice(0, 65) + ' | ' + dl);
  });

  // Show reviewing
  const { data: reviewing } = await supabase.from('opportunities')
    .select('title,score,notes,response_deadline')
    .eq('status', 'reviewing')
    .order('score', { ascending: false });

  console.log('\n===== REVIEWING (' + reviewing.length + ') =====');
  reviewing.forEach((o, i) => {
    const dl = o.response_deadline ? new Date(o.response_deadline).toLocaleDateString() : 'no deadline';
    console.log((i + 1) + '. [' + o.score + '] ' + o.title.slice(0, 65) + ' | ' + dl);
    console.log('   ' + (o.notes || '').slice(0, 100));
  });

  // Final counts
  for (const status of ['new', 'reviewing', 'passed']) {
    const { count } = await supabase.from('opportunities').select('*', { count: 'exact', head: true }).eq('status', status);
    console.log(status + ': ' + count);
  }
}

run().catch(e => console.error(e));
