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

  // Calculate total score, clamped 0–100
  const rawScore = signals.reduce((sum, s) => (s.fired ? sum + s.delta : sum), 0);
  const score = Math.max(0, Math.min(100, rawScore));

  return { score, signals };
}
