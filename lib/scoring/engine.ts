import { ScoringConfig, ScoreResult, ScoreSignal } from '@/types/scoring';

export interface ScoringInput {
  title: string;
  description: string | null;
  naics_code: string | null;
  dollar_min: number | null;
  dollar_max: number | null;
  place_of_performance?: string;
}

function textContains(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

function searchableText(input: ScoringInput): string {
  return [input.title, input.description].filter(Boolean).join(' ');
}

/**
 * Overseas / non-continental-US indicators used by the Continental US signal.
 * If any of these substrings appear in the place_of_performance field the
 * signal will NOT fire (opportunity is likely outside CONUS).
 */
const OVERSEAS_INDICATORS = [
  'japan',
  'korea',
  'germany',
  'overseas',
  'foreign',
  'oconus',
  'far east',
  'pacific',
  'europe',
  'middle east',
  'guam',
  'puerto rico',
  'hawaii',
  'alaska',
];

/**
 * Check whether the opportunity's place of performance is Continental US.
 * Returns true (fire the +10 signal) when:
 *   - No place data is provided (default to CONUS)
 *   - Place data exists but contains none of the overseas indicators
 */
function isContinentalUS(place: string | undefined): boolean {
  if (!place) return true; // default to CONUS when unknown
  const lower = place.toLowerCase();
  return !OVERSEAS_INDICATORS.some((indicator) => lower.includes(indicator));
}

/**
 * States/regions within ~4 hours drive of Racine, WI.
 * Used to determine if a site visit is feasible without air travel.
 */
const NEARBY_STATES = [
  'wisconsin', 'wi',
  'illinois', 'il',
  'indiana', 'in',
  'michigan', 'mi',
  'iowa', 'ia',
  'minnesota', 'mn',
  'missouri', 'mo',
  'ohio', 'oh',        // western OH is ~5hrs but close enough
  'kentucky', 'ky',    // northern KY (Cincinnati area)
];

/** Cities that are definitely within ~4 hours of Racine */
const NEARBY_CITIES = [
  'chicago', 'milwaukee', 'madison', 'green bay', 'racine', 'kenosha',
  'rockford', 'peoria', 'springfield', 'indianapolis', 'detroit',
  'grand rapids', 'minneapolis', 'st. paul', 'des moines', 'st. louis',
  'fort wayne', 'south bend', 'gary', 'joliet', 'aurora', 'naperville',
  'great lakes', 'waukegan', 'duluth', 'lansing', 'ann arbor', 'davenport',
  'quad cities', 'dubuque', 'cedar rapids', 'champaign', 'kalamazoo',
  'bloomington', 'normal', 'elgin', 'cicero', 'evanston', 'oak park',
];

/**
 * Check if an opportunity's place of performance is within ~4 hours of Racine, WI.
 * Returns: true = nearby, false = far away, null = can't determine
 */
function isNearRacine(place: string | undefined): boolean | null {
  if (!place) return null;
  const lower = place.toLowerCase();

  // Check nearby cities first (most specific)
  if (NEARBY_CITIES.some((city) => lower.includes(city))) return true;

  // Check state abbreviations and names
  if (NEARBY_STATES.some((st) => lower.includes(st))) return true;

  // If we have location data but it doesn't match nearby — it's far
  // Only if the data looks like it contains a real location (has a comma or state-like text)
  if (lower.includes(',') || /\b[a-z]{2}\b/.test(lower)) return false;

  return null; // can't determine
}

/**
 * Check if the opportunity mentions drawings/prints/specs that would
 * allow bidding without a site visit.
 */
function hasDrawingsOrPrints(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('drawings') ||
    lower.includes('prints') ||
    lower.includes('blueprints') ||
    lower.includes('shop drawings') ||
    lower.includes('specifications attached') ||
    lower.includes('see attached') ||
    lower.includes('per plans') ||
    lower.includes('per specification') ||
    lower.includes('scope of work attached') ||
    lower.includes('sow attached')
  );
}

export function scoreOpportunity(input: ScoringInput, config: ScoringConfig | null | undefined): ScoreResult {
  // Guard: if config is missing, return score 0 with an explanation signal
  if (!config) {
    return {
      score: 0,
      signals: [{ signal: 'No config loaded', delta: 0, fired: true }],
    };
  }

  const signals: ScoreSignal[] = [];
  const text = searchableText(input);

  // --- Positive signals ---

  // NAICS code match: +30
  const naicsMatch = input.naics_code != null && config.naics_codes.includes(input.naics_code);
  signals.push({ signal: 'NAICS code match', delta: 30, fired: naicsMatch });

  // Dollar range match ($10K–$1.5M configurable): +20
  const dollarMax = input.dollar_max ?? input.dollar_min;
  const dollarInRange =
    dollarMax != null && dollarMax >= config.dollar_min && dollarMax <= config.dollar_max;
  signals.push({ signal: 'Dollar range match', delta: 20, fired: dollarInRange });

  // Primary keyword match: +20
  // DEFAULT primary keywords (actual list loaded from DB/Supabase config):
  //   welding, fabrication, metalwork, steel fabrication, structural steel,
  //   handrail, railing, misc metals, miscellaneous metals, metal stairs,
  //   stair rail, guardrail, bollard, ladder, platform, canopy, awning,
  //   metal door frame, hollow metal, aluminum welding, stainless steel,
  //   ornamental iron, wrought iron, metal repair, weld repair
  const primaryHit = config.keyword_primary.some((kw) => textContains(text, kw));
  signals.push({ signal: 'Primary keyword match', delta: 20, fired: primaryHit });

  // Secondary keyword match: +10
  const secondaryHit = config.keyword_secondary.some((kw) => textContains(text, kw));
  signals.push({ signal: 'Secondary keyword match', delta: 10, fired: secondaryHit });

  // Continental US: +10 — check place_of_performance for overseas indicators
  const continentalUS = isContinentalUS(input.place_of_performance);
  signals.push({ signal: 'Continental US', delta: 10, fired: continentalUS });

  // Near Racine, WI bonus: configurable from scoring_config.target_state_bonus
  // Jobs within ~4 hours driving distance get a bonus
  const nearRacine = isNearRacine(input.place_of_performance);
  const nearbyJob = nearRacine === true;
  const targetBonus = config.target_state_bonus ?? 15;
  signals.push({
    signal: `Within driving distance of Racine (${config.target_states?.join('/') || 'WI/IL/IA/MN/IN'})`,
    delta: targetBonus,
    fired: nearbyJob,
  });

  // Out-of-region penalty: if place is CONUS but clearly NOT in target states,
  // apply a penalty proportional to how far. Tionesta Dam (PA), Mammoth Cave (KY),
  // New Castle (NH) all previously slipped through as qa_qualified.
  const outOfRegionPenalty = config.out_of_region_penalty ?? 20;
  const outOfRegion = nearRacine === false && continentalUS;
  signals.push({
    signal: 'Out-of-region (CONUS but not WI/nearby)',
    delta: -outOfRegionPenalty,
    fired: outOfRegion,
  });

  // --- Negative signals ---

  // Davis-Bacon / certified payroll: -15
  const davisBacon =
    textContains(text, 'davis-bacon') ||
    textContains(text, 'davis bacon') ||
    textContains(text, 'certified payroll') ||
    textContains(text, 'prevailing wage');
  signals.push({ signal: 'Davis-Bacon / certified payroll', delta: -15, fired: davisBacon });

  // Dollar value below $5K: -25
  const tooSmall = dollarMax != null && dollarMax < 5000;
  signals.push({ signal: 'Dollar value below $5K', delta: -25, fired: tooSmall });

  // Dollar value above $2M: -20
  const dollarMinVal = input.dollar_min ?? input.dollar_max;
  const tooLarge = dollarMinVal != null && dollarMinVal > 2000000;
  signals.push({ signal: 'Dollar value above $2M', delta: -20, fired: tooLarge });

  // Supply-only (no fabrication/installation): -20
  // Only fires on exact supply-only phrases, not the word "supply" by itself
  const supplyOnly =
    textContains(text, 'supply only') ||
    textContains(text, 'supply-only') ||
    textContains(text, 'supplies only') ||
    textContains(text, 'material supply');
  signals.push({ signal: 'Supply-only (no fabrication)', delta: -20, fired: supplyOnly });

  // Disqualifying certifications: -15
  const certDisqualify = config.keyword_disqualify.some((kw) => textContains(text, kw));
  signals.push({ signal: 'Certification not held', delta: -15, fired: certDisqualify });

  // DLA manufactured parts / NSN procurement / military spare parts: -30
  // These are commodity supply orders for existing manufactured parts, not fabrication work.
  // Also catches truncated all-caps DLA catalog titles like "PUMP,ROTARY" or "VALVE,GATE"
  const titleTrimmed = input.title.trim();
  const dlaParts =
    textContains(text, 'proposed procurement for nsn') ||
    textContains(text, 'national stock number') ||
    /^\d{2}--/.test(titleTrimmed) ||
    textContains(text, 'dla troop support') ||
    textContains(text, 'dla land and maritime') ||
    textContains(text, 'dla aviation') ||
    // DLA catalog-style titles: ALL CAPS, short, comma-separated part name
    // e.g. "PUMP,ROTARY", "VALVE,GATE", "STARTER,ENGINE,AIR", "CIRCUIT CARD ASSEMB"
    (/^[A-Z][A-Z ,\-/]{3,}$/.test(titleTrimmed) && titleTrimmed.length < 40) ||
    // Repair/modification of specific parts
    textContains(text, 'in repair/modification of');
  signals.push({ signal: 'DLA manufactured parts / NSN', delta: -30, fired: dlaParts });

  // Site visit / travel analysis
  // Mandatory site visit at a distant location = big penalty
  // Site visit nearby Racine WI = no penalty
  // Job has prints/drawings = site visit is less critical, reduced penalty
  const mentionsSiteVisit =
    textContains(text, 'site visit') ||
    textContains(text, 'pre-bid conference') ||
    textContains(text, 'pre-proposal conference') ||
    textContains(text, 'mandatory walk') ||
    textContains(text, 'mandatory inspection');

  const hasDrawings = hasDrawingsOrPrints(text);

  // Far from Racine with mandatory site visit = -20
  // Far from Racine, no site visit mentioned but still far = -5
  // Site visit required but has drawings/prints (can bid off specs) = -5
  // Near Racine or unknown location = no penalty
  let siteVisitDelta = 0;
  let siteVisitFired = false;
  let siteVisitLabel = 'Location / site visit';

  if (mentionsSiteVisit && nearRacine === false && !hasDrawings) {
    siteVisitDelta = -20;
    siteVisitFired = true;
    siteVisitLabel = 'Mandatory site visit — far from Racine, WI';
  } else if (mentionsSiteVisit && nearRacine === false && hasDrawings) {
    siteVisitDelta = -5;
    siteVisitFired = true;
    siteVisitLabel = 'Site visit far away but has prints/drawings';
  } else if (!mentionsSiteVisit && nearRacine === false) {
    siteVisitDelta = -5;
    siteVisitFired = true;
    siteVisitLabel = 'Far from Racine, WI (may require travel)';
  } else if (mentionsSiteVisit && (nearRacine === true || nearRacine === null)) {
    siteVisitDelta = 0;
    siteVisitFired = false;
    siteVisitLabel = 'Site visit — within driving distance';
  }
  signals.push({ signal: siteVisitLabel, delta: siteVisitDelta, fired: siteVisitFired });

  // Non-fabrication primary work: -20
  // If the primary scope is paving, concrete, roofing, HVAC, electrical, etc.
  // these are not metal fab jobs even if they mention bollards or railings as minor items
  const nonFabPrimary =
    textContains(text, 'concrete pour') ||
    textContains(text, 'repaving') ||
    textContains(text, 'asphalt') ||
    textContains(text, 'roofing') ||
    textContains(text, 'roof replacement') ||
    textContains(text, 'hvac') ||
    textContains(text, 'plumbing') ||
    textContains(text, 'electrical contractor') ||
    textContains(text, 'painting services') ||
    textContains(text, 'janitorial') ||
    textContains(text, 'landscaping') ||
    textContains(text, 'mowing') ||
    textContains(text, 'demolition only') ||
    textContains(text, 'fall protection engineering') ||
    textContains(text, 'fall protection program');
  signals.push({ signal: 'Non-fabrication primary work', delta: -20, fired: nonFabPrimary });

  // Calculate total score, clamped 0–100
  const rawScore = signals.reduce((sum, s) => (s.fired ? sum + s.delta : sum), 0);
  const score = Math.max(0, Math.min(100, rawScore));

  return { score, signals };
}
