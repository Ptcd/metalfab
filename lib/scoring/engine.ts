import { ScoringConfig, ScoreResult, ScoreSignal } from '@/types/scoring';

interface ScoringInput {
  title: string;
  description: string | null;
  naics_code: string | null;
  dollar_min: number | null;
  dollar_max: number | null;
}

function textContains(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

function searchableText(input: ScoringInput): string {
  return [input.title, input.description].filter(Boolean).join(' ');
}

export function scoreOpportunity(input: ScoringInput, config: ScoringConfig): ScoreResult {
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
  const primaryHit = config.keyword_primary.some((kw) => textContains(text, kw));
  signals.push({ signal: 'Primary keyword match', delta: 20, fired: primaryHit });

  // Secondary keyword match: +10
  const secondaryHit = config.keyword_secondary.some((kw) => textContains(text, kw));
  signals.push({ signal: 'Secondary keyword match', delta: 10, fired: secondaryHit });

  // Continental US (always true for SAM.gov — domestic opportunities): +10
  signals.push({ signal: 'Continental US', delta: 10, fired: true });

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
  const supplyOnly =
    textContains(text, 'supply only') ||
    textContains(text, 'supply-only') ||
    (textContains(text, 'supply') &&
      !textContains(text, 'fabricat') &&
      !textContains(text, 'install'));
  signals.push({ signal: 'Supply-only (no fabrication)', delta: -20, fired: supplyOnly });

  // Disqualifying certifications: -15
  const certDisqualify = config.keyword_disqualify.some((kw) => textContains(text, kw));
  signals.push({ signal: 'Certification not held', delta: -15, fired: certDisqualify });

  // Calculate total score, clamped 0–100
  const rawScore = signals.reduce((sum, s) => (s.fired ? sum + s.delta : sum), 0);
  const score = Math.max(0, Math.min(100, rawScore));

  return { score, signals };
}
