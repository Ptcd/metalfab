/**
 * lib/takeoff/confidence.js — deterministic per-line confidence scoring.
 *
 * Replaces the LLM-supplied confidence number with an algebra:
 *
 *     confidence = source_authority
 *                × quantity_precision
 *                × corroboration_boost
 *                × band_tightness
 *
 * Each factor is a number in (0, 1.05]. The result is clamped to
 * [0.30, 0.99]. Confidence becomes a transparent function of evidence
 * — not the LLM's guess about how sure it is.
 *
 * Run on every takeoff_line at commit time (scripts/takeoff-commit.js)
 * AND on every PATCH (lib/takeoff/persist.ts). Lines with high-quality
 * data (parsed schedule rows, dimensioned details) come out at 0.85-
 * 0.97; lines based on assumptions land at 0.40-0.55.
 */

function sourceAuthority(line) {
  if (line.from_schedule === true) return 0.95;
  switch ((line.source_kind || '').toLowerCase()) {
    case 'drawing':            return 0.90;
    case 'spec':               return 0.75;
    case 'qa':                 return 0.78;
    case 'audit':              return 0.65;
    case 'manual':             return 0.85;
    case 'industry_default':   return 0.45;
    case 'assumption':
    default:                   return 0.50;
  }
}

function quantityPrecision(line) {
  switch ((line.quantity_band || '').toLowerCase()) {
    case 'point':            return 1.00;
    case 'range':            return 0.92;
    case 'assumed_typical':  return 0.78;
    default:                 return 0.85;
  }
}

function corroborationBoost(line) {
  const n = Math.max(1, line.corroborating_sources || 1);
  return Math.min(1.10, 1.00 + (n - 1) * 0.05);
}

function bandTightness(line) {
  const { quantity, quantity_min, quantity_max } = line;
  if (quantity == null || quantity === 0 || quantity_min == null || quantity_max == null) return 1.00;
  const span = Math.max(quantity_max - quantity_min, 0);
  const ratio = span / Math.max(quantity, 1);
  return Math.max(0.75, 1.00 - 0.125 * ratio);
}

function computeConfidence(line) {
  const auth = sourceAuthority(line);
  const prec = quantityPrecision(line);
  const corr = corroborationBoost(line);
  const tight = bandTightness(line);
  const raw = auth * prec * corr * tight;
  return Math.max(0.30, Math.min(0.99, raw));
}

function explainConfidence(line) {
  const auth = sourceAuthority(line);
  const prec = quantityPrecision(line);
  const corr = corroborationBoost(line);
  const tight = bandTightness(line);
  const total = computeConfidence(line);
  return {
    total,
    factors: [
      { name: 'source authority', value: auth, rationale: line.from_schedule ? 'parsed from a real schedule row' : `source kind: ${line.source_kind || 'assumption'}` },
      { name: 'quantity precision', value: prec, rationale: `quantity_band: ${line.quantity_band || 'unknown'}` },
      { name: 'corroboration', value: corr, rationale: `${line.corroborating_sources || 1} confirming source(s)` },
      { name: 'band tightness', value: tight, rationale: line.quantity_min != null && line.quantity_max != null
          ? `range ${line.quantity_min}-${line.quantity_max} around ${line.quantity}`
          : 'no min/max specified' },
    ],
  };
}

module.exports = { computeConfidence, explainConfidence };
