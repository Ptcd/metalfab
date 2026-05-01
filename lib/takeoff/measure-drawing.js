/**
 * lib/takeoff/measure-drawing.js — measure architectural drawings
 * directly to tight tolerance, the way PlanBeam / On-Screen Takeoff
 * estimators do.
 *
 * Why: V.I.F. dimensions and "approximately 9'-8"" annotations
 * leave too much wiggle room. For bid purposes, we should be able to
 * measure the drawing geometry to ±2% and call it good.
 *
 * Math:
 *   - PDF page rendered at pdf-to-img scale=N at 72 DPI base
 *     → effective DPI = 72 × N. (Verified empirically: scale=4 on
 *     a 36"×24" Arch D page produces 10368×6912 px → 288 DPI.)
 *   - Architectural scale "1/2\" = 1'-0\"" means 0.5" of drawing
 *     represents 12" of building. At 288 DPI, 0.5" of drawing =
 *     144 pixels → 144 px = 1 ft of building.
 *   - General formula: px_per_foot = (drawing_inches_per_foot) × DPI
 *     where drawing_inches_per_foot is 0.5 for 1/2"=1'-0", 1 for
 *     1"=1'-0", 0.25 for 1/4"=1'-0", etc.
 *
 * Usage:
 *   const m = pixelsPerFoot({ renderScale: 4, drawingScale: '1/2"=1\'-0"' });
 *   const lengthFt = measureDistance(p1, p2, m);
 *
 * Standard architectural scales:
 *   1/16"=1'-0", 1/8"=1'-0", 3/16"=1'-0", 1/4"=1'-0", 3/8"=1'-0",
 *   1/2"=1'-0", 3/4"=1'-0", 1"=1'-0", 1-1/2"=1'-0", 3"=1'-0",
 *   plus structural typical 1"=1'-0" and 1-1/2"=1'-0" for sections.
 */

const PDF_BASE_DPI = 72;  // pdf-to-img / pdfjs base DPI

/**
 * Parse an architectural scale string like '1/2" = 1\'-0"' or
 * '1/4"=1'-0"' or 'SCALE: 1"=1\'-0"'. Returns the drawing-inches-
 * per-building-foot ratio (0.5 for 1/2"=1'-0", 0.25 for 1/4"=1'-0",
 * etc.) or null if unparseable.
 */
function parseDrawingScale(s) {
  if (!s) return null;
  // Common forms: "1/2\" = 1'-0\"", "SCALE: 1/4\"=1'-0\"", "1\"=1'-0\""
  // Fraction, integer, or mixed (1-1/2")
  const re = /(?:SCALE\s*:?\s*)?(\d+(?:[\s-]\d+\/\d+)?|\d+\/\d+)\s*"\s*=\s*1\s*'\s*-?\s*0?\s*"?/i;
  const m = String(s).match(re);
  if (!m) return null;
  const numStr = m[1];
  // Mixed number: "1-1/2" or "1 1/2"
  const mixed = numStr.match(/^(\d+)[\s-](\d+)\/(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (den > 0) return whole + (num / den);
  }
  // Fraction
  const frac = numStr.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    if (den > 0) return num / den;
  }
  // Integer
  const int = numStr.match(/^(\d+)$/);
  if (int) return Number(int[1]);
  return null;
}

/**
 * Compute pixels-per-foot for a rendered drawing.
 *
 * @param {Object} opts
 * @param {number} opts.renderScale     — pdf-to-img scale (e.g. 4)
 * @param {string} opts.drawingScale    — architectural scale string
 *                                         (e.g. '1/2"=1\'-0"')
 * @returns {number} pixels per foot of building, or null if invalid.
 */
function pixelsPerFoot({ renderScale, drawingScale }) {
  const drawIn = parseDrawingScale(drawingScale);
  if (drawIn === null || drawIn === 0) return null;
  if (!Number.isFinite(renderScale) || renderScale <= 0) return null;
  const dpi = PDF_BASE_DPI * renderScale;
  return drawIn * dpi;
}

/**
 * Euclidean distance in feet between two pixel coordinates given a
 * pixels-per-foot ratio.
 *
 * @param {{x:number,y:number}} p1
 * @param {{x:number,y:number}} p2
 * @param {number} pxPerFoot
 * @returns {number} distance in feet
 */
function measureDistance(p1, p2, pxPerFoot) {
  if (!pxPerFoot) return null;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const px = Math.sqrt(dx * dx + dy * dy);
  return px / pxPerFoot;
}

/**
 * Measure a polyline (chain of points) total length in feet.
 */
function measurePolyline(points, pxPerFoot) {
  if (!Array.isArray(points) || points.length < 2 || !pxPerFoot) return null;
  let totalPx = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    totalPx += Math.sqrt(dx * dx + dy * dy);
  }
  return totalPx / pxPerFoot;
}

/**
 * Convert a measured value back to architectural feet-and-inches
 * notation (e.g. 12.5 → "12'-6\"").
 */
function feetToArchString(feet) {
  if (!Number.isFinite(feet)) return null;
  const sign = feet < 0 ? '-' : '';
  feet = Math.abs(feet);
  const wholeFt = Math.floor(feet);
  const remIn = (feet - wholeFt) * 12;
  // Round inches to nearest 1/16
  const sixteenths = Math.round(remIn * 16);
  if (sixteenths === 0) return `${sign}${wholeFt}'-0"`;
  if (sixteenths === 192) return `${sign}${wholeFt + 1}'-0"`;  // 12 in
  const wholeIn = Math.floor(sixteenths / 16);
  const fracSixteenths = sixteenths - wholeIn * 16;
  if (fracSixteenths === 0) return `${sign}${wholeFt}'-${wholeIn}"`;
  // Reduce fraction
  let num = fracSixteenths, den = 16;
  while (num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
  return `${sign}${wholeFt}'-${wholeIn} ${num}/${den}"`;
}

module.exports = {
  parseDrawingScale,
  pixelsPerFoot,
  measureDistance,
  measurePolyline,
  feetToArchString,
  PDF_BASE_DPI,
};
