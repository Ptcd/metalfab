/**
 * lib/takeoff/measure-callout.js — turn a coded-note callout
 * into a measurement, instead of an allowance.
 *
 * The takeoff agent's #1 failure mode is: when a quantity is not
 * obvious from text alone, drop a "30 LF allowance, RFI for length"
 * line and ship it at confidence 0.50. This module gives the agent
 * a measurement primitive so the lazy_allowance validator can be
 * satisfied with a real number.
 *
 * Inputs are page-level text-content items already extracted by
 * pdfjs (lib/plan-intelligence/index.js). For each callout location
 * (page, x, y), this returns:
 *   - dimensions_within_radius  (sorted by distance)
 *   - dimension_chain           (collinear runs interpreted as a chain)
 *   - callout_symbol_count      (rough count of identical symbols
 *                                  on the same page, e.g. "E60 TYP")
 *   - measured_inches / null    (the agent's best single-number
 *                                  measurement, with rationale)
 */

const DIM_RE = /^(\d+)'\s*-?\s*(\d+)?\s*(\d+\/\d+)?"\s*(?:\+\/-)?$/;
const ANY_DIM_RE = /\d+'\s*-?\s*\d/;

function parseDim(s) {
  const m = String(s || '').trim().match(DIM_RE);
  if (!m) return null;
  const ft = parseInt(m[1], 10);
  const inch = m[2] ? parseInt(m[2], 10) : 0;
  let frac = 0;
  if (m[3]) {
    const [a, b] = m[3].split('/').map(Number);
    if (b > 0) frac = a / b;
  }
  return ft * 12 + inch + frac;
}

/**
 * Pull dimension strings within `radius` px of (x,y) on the
 * same page.
 */
function dimensionsNear(pageItems, x, y, radius = 250) {
  const out = [];
  for (const it of pageItems) {
    const s = (it.str || '').trim();
    if (!s) continue;
    const inches = parseDim(s);
    if (inches === null && !ANY_DIM_RE.test(s)) continue;
    const dx = it.x - x;
    const dy = it.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius) continue;
    out.push({ x: it.x, y: it.y, dist, str: s, inches });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/**
 * Identify a chain of dimensions sharing roughly the same y (or x)
 * — typical layout for "5'-0 | 4'-6 | 4'-6 | 4'-6" along a wall.
 * Returns the collinear sub-list with summed inches.
 */
function dimensionChain(dims, axisTol = 8) {
  if (dims.length < 2) return null;
  // Try grouping by y, then by x.
  for (const axis of ['y', 'x']) {
    const buckets = new Map();
    for (const d of dims) {
      if (d.inches === null) continue;
      const key = Math.round(d[axis] / axisTol) * axisTol;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(d);
    }
    let best = null;
    for (const [key, list] of buckets) {
      if (list.length < best?.length) continue;
      if (list.length >= 3 && (!best || list.length > best.list.length)) {
        const sortedAxis = axis === 'y' ? 'x' : 'y';
        list.sort((a, b) => a[sortedAxis] - b[sortedAxis]);
        const totalInches = list.reduce((acc, d) => acc + d.inches, 0);
        best = { axis, key, list, totalInches };
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Count how many times an exact symbol (e.g. "E60", "A1.08")
 * appears on a given page. Used to disambiguate "E60 TYP" — if
 * there are 5 E60 symbols on the page, TYP means 5.
 */
function calloutSymbolCount(pageItems, symbol) {
  const re = new RegExp(`^${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return pageItems.filter((it) => re.test((it.str || '').trim())).length;
}

/**
 * Convenience: given a callout, return the agent's best single
 * numeric measurement for its companion dimension. Caller decides
 * whether to use chain total, single nearest, or symbol count.
 */
function measureCallout({ pageItems, x, y, symbol, radius = 250 }) {
  const dims = dimensionsNear(pageItems, x, y, radius);
  const chain = dimensionChain(dims);
  const symCount = symbol ? calloutSymbolCount(pageItems, symbol) : null;

  let bestMeasurementInches = null;
  let rationale = null;

  if (chain && chain.list.length >= 3) {
    bestMeasurementInches = chain.totalInches;
    rationale = `dimension chain along ${chain.axis}=${chain.key}: ${chain.list.map((d) => d.str).join(' | ')} = ${(chain.totalInches / 12).toFixed(1)} LF`;
  } else if (dims.length > 0 && dims[0].inches !== null) {
    bestMeasurementInches = dims[0].inches;
    rationale = `nearest dimension: "${dims[0].str}" at ${dims[0].dist.toFixed(0)}px from callout`;
  }

  return {
    callout: { x, y, symbol },
    radius_px: radius,
    dimensions_within_radius: dims.slice(0, 12).map((d) => ({
      str: d.str, inches: d.inches, dist_px: Math.round(d.dist),
    })),
    dimension_chain: chain ? {
      axis: chain.axis,
      key: chain.key,
      values: chain.list.map((d) => d.str),
      total_inches: chain.totalInches,
      total_lf: chain.totalInches / 12,
    } : null,
    callout_symbol_count: symCount,
    measured_inches: bestMeasurementInches,
    measured_lf: bestMeasurementInches !== null ? bestMeasurementInches / 12 : null,
    rationale,
  };
}

module.exports = {
  parseDim,
  dimensionsNear,
  dimensionChain,
  calloutSymbolCount,
  measureCallout,
};
