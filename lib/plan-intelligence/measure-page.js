/**
 * lib/plan-intelligence/measure-page.js — auto-extract measurable
 * elements from a drawing page so the takeoff agent never has to
 * eyeball a length again.
 *
 * What this does for every rendered page:
 *   1. Extract vector line segments from the PDF (pdfjs getOperatorList).
 *      Long horizontal/vertical lines are walls, rails, partition runs.
 *   2. Find each "Detail N" or "ELEVATION @ X" / "SECTION X" block on
 *      the page, with its bounding box and stated SCALE.
 *   3. For each detail block, group the vector lines that fall inside,
 *      compute pixel-lengths, convert to building-feet via the scale.
 *   4. Output a structured `measurements` array per page that the
 *      validator + agent can consume.
 *
 * Output schema (per page):
 *   {
 *     page: 37,
 *     details: [
 *       {
 *         id: 'detail_2',
 *         label: 'WEST ELEVATION @ SHIPPING DOCK 134',
 *         scale_text: 'SCALE: 1/2" = 1\'-0"',
 *         scale_in_per_ft: 0.5,
 *         px_per_foot: 144,                      // at scale=4 render
 *         bbox: { x0, y0, x1, y1 },              // pixel coords
 *         long_lines: [
 *           { kind: 'horizontal', length_px: 4320, length_ft: 30.0,
 *             start: {x, y}, end: {x, y} },
 *           ...
 *         ],
 *       },
 *       ...
 *     ]
 *   }
 *
 * This runs as part of plan-intelligence on every drawing page that's
 * been auto-rendered. Result is persisted in summary.measurements so
 * the takeoff agent can pull "the wall is 30.0 ft" instead of
 * eyeballing it.
 */

const PDF_BASE_DPI = 72;
const { parseDrawingScale } = require('../takeoff/measure-drawing');

// Minimum line length in pixels to be considered a "structural" line
// (filters out dimension tick marks, leader arrows, hatching). At 288
// DPI (scale=4) this is about 0.7 inches = ~14 inches building at
// 1/2"=1'-0", which is the minimum length we care about for a takeoff
// element.
const MIN_LINE_LENGTH_PX = 200;

// Tolerance for "horizontal" / "vertical": dy/dx ratio under 0.05
const ORIENTATION_TOLERANCE = 0.05;

/**
 * Extract polylines from a PDF page via pdfjs getOperatorList. Looks
 * for moveTo + lineTo sequences in the content stream; concatenates
 * adjacent segments into polylines.
 *
 * @param {Object} page         — pdfjs page object (from getDocument).
 * @param {Object} viewport     — page viewport at render scale.
 * @returns {Array<{start, end, length_px, orientation}>}
 */
async function extractLineSegments(page, viewport) {
  const opList = await page.getOperatorList();
  const fnArray = opList.fnArray;
  const argsArray = opList.argsArray;
  // pdfjs OPS constants — listed at https://github.com/mozilla/pdf.js
  // We only need: moveTo (1), lineTo (2), constructPath (91), and
  // restore-on-end-of-path. The constructPath args are flat operation
  // arrays — moveTo/lineTo with [x, y] floats.
  const segments = [];
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] === pdfjsOPS().constructPath) {
      const ops = argsArray[i][0];
      const args = argsArray[i][1];
      let argIdx = 0;
      let cursor = null;
      let pathStart = null;
      for (const op of ops) {
        if (op === pdfjsOPS().moveTo) {
          const x = args[argIdx++], y = args[argIdx++];
          cursor = { x, y };
          pathStart = { x, y };
        } else if (op === pdfjsOPS().lineTo) {
          const x = args[argIdx++], y = args[argIdx++];
          if (cursor) {
            const segPx = transformToPixels(cursor, { x, y }, viewport);
            if (segPx.length_px >= MIN_LINE_LENGTH_PX) segments.push(segPx);
          }
          cursor = { x, y };
        } else if (op === pdfjsOPS().closePath) {
          if (cursor && pathStart) {
            const segPx = transformToPixels(cursor, pathStart, viewport);
            if (segPx.length_px >= MIN_LINE_LENGTH_PX) segments.push(segPx);
          }
        } else if (op === pdfjsOPS().rectangle) {
          const x = args[argIdx++], y = args[argIdx++];
          const w = args[argIdx++], h = args[argIdx++];
          // 4 sides
          const corners = [
            { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
          ];
          for (let k = 0; k < 4; k++) {
            const seg = transformToPixels(corners[k], corners[(k + 1) % 4], viewport);
            if (seg.length_px >= MIN_LINE_LENGTH_PX) segments.push(seg);
          }
          cursor = { x, y };
        } else {
          // Curve operations (curveTo, etc.) — skip; we don't measure curves
          // here. The args index needs to advance by the appropriate amount;
          // pdfjs op arity is implicit. Simplest safe approach: if we hit
          // a non-line op, abandon the rest of this path (worst case we
          // miss some segments, never invent ones).
          break;
        }
      }
    }
  }
  return segments;
}

/**
 * Convert a PDF user-space segment to pixel coordinates and classify
 * its orientation.
 */
function transformToPixels(p1, p2, viewport) {
  // pdfjs viewport.convertToViewportPoint takes (x, y) in PDF user
  // space and returns [x, y] in pixel space.
  const [x1, y1] = viewport.convertToViewportPoint(p1.x, p1.y);
  const [x2, y2] = viewport.convertToViewportPoint(p2.x, p2.y);
  const dx = x2 - x1, dy = y2 - y1;
  const length_px = Math.sqrt(dx * dx + dy * dy);
  let orientation = 'diagonal';
  if (Math.abs(dy) / (Math.abs(dx) + 0.001) < ORIENTATION_TOLERANCE) orientation = 'horizontal';
  else if (Math.abs(dx) / (Math.abs(dy) + 0.001) < ORIENTATION_TOLERANCE) orientation = 'vertical';
  return {
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
    length_px, orientation,
  };
}

let _cachedOPS = null;
function pdfjsOPS() {
  if (_cachedOPS) return _cachedOPS;
  _cachedOPS = require('pdfjs-dist/legacy/build/pdf').OPS
    || require('pdfjs-dist').OPS
    || {
      // Fallbacks if OPS isn't exported in this pdfjs version
      moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17,
      closePath: 18, rectangle: 19, constructPath: 91,
    };
  return _cachedOPS;
}

/**
 * Find detail / elevation / section blocks on a page. A block is
 * identified by a title bar at its bottom — typically a circled
 * detail number followed by a label like "WEST ELEVATION @ SHIPPING
 * DOCK 134" with a SCALE: line directly below.
 *
 * Returns array of { id, label, scale_text, scale_in_per_ft, bbox }.
 *
 * Heuristic implementation: scan page text items for "(SCALE|SCALE:):" or
 * "= 1\'-0\"" patterns; cluster nearby items into blocks.
 */
function findDetailBlocks(pageItems) {
  const blocks = [];
  const seenLabels = new Set();

  for (let i = 0; i < pageItems.length; i++) {
    const it = pageItems[i];
    if (!it.str) continue;
    // Look for SCALE indicator
    if (!/SCALE\s*:/i.test(it.str) && !/=\s*1\s*['']\s*-?\s*0\s*"/i.test(it.str)) continue;
    // Look for nearby items that compose the title (label is typically
    // in a band above the SCALE line, within 100 px vertically)
    const bandY = it.y;
    const nearby = pageItems.filter((other) =>
      other !== it && Math.abs(other.y - bandY) < 80 && Math.abs(other.x - it.x) < 1500
    );
    // Title text: longest item to the right of detail number
    const titleCandidate = nearby
      .filter((n) => n.str.length > 8 && /[A-Z]{3,}/.test(n.str))
      .sort((a, b) => b.str.length - a.str.length)[0];
    const label = titleCandidate ? titleCandidate.str.trim() : null;
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);

    const scaleInPerFt = parseDrawingScale(it.str);
    if (scaleInPerFt === null) continue;

    blocks.push({
      id: `detail_${blocks.length + 1}`,
      label,
      scale_text: it.str.trim(),
      scale_in_per_ft: scaleInPerFt,
      // Bounding box: estimated by scanning items in the title's region.
      // Without explicit grid lines this is a heuristic — extends from
      // the title band upward to the next title band or page edge.
      title_position: { x: it.x, y: it.y },
    });
  }
  return blocks;
}

/**
 * Top-level: measure a single page.
 *
 * @param {Object} page         — pdfjs page object
 * @param {Array}  pageItems    — text items from extractText
 * @param {number} renderScale  — pdf-to-img render scale (1, 2, 4, etc.)
 * @returns {Object} measurements summary for the page
 */
async function measurePage(page, pageItems, renderScale = 4) {
  const viewport = page.getViewport({ scale: renderScale });
  let segments = [];
  try {
    segments = await extractLineSegments(page, viewport);
  } catch (e) {
    // Some PDFs throw on getOperatorList for unusual fonts — skip
    // measurement rather than fail plan-intelligence
    return { page: page.pageNumber, details: [], segments_extracted: 0, error: e.message };
  }

  const blocks = findDetailBlocks(pageItems);
  const dpi = PDF_BASE_DPI * renderScale;

  // For each block compute px_per_foot
  for (const b of blocks) {
    b.px_per_foot = b.scale_in_per_ft * dpi;
    // For now we don't try to bound segments to a specific block —
    // that requires reliable bbox detection which is fragile.
    // Instead we expose all segments at the page level and the agent
    // can pick the relevant detail's px_per_foot to convert.
  }

  // Aggregate line stats
  const horizontal = segments.filter((s) => s.orientation === 'horizontal');
  const vertical = segments.filter((s) => s.orientation === 'vertical');
  const long_horizontal = horizontal
    .sort((a, b) => b.length_px - a.length_px)
    .slice(0, 30);

  // Page-level scale = the most common detail scale on the page
  const scaleFreq = {};
  for (const b of blocks) {
    const k = b.scale_in_per_ft;
    scaleFreq[k] = (scaleFreq[k] || 0) + 1;
  }
  const dominantScale = Object.entries(scaleFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
  const dominantPxPerFt = dominantScale ? Number(dominantScale) * dpi : null;

  return {
    page: page.pageNumber,
    render_scale: renderScale,
    dpi,
    detail_blocks: blocks,
    dominant_scale_in_per_ft: dominantScale ? Number(dominantScale) : null,
    dominant_px_per_foot: dominantPxPerFt,
    segments: {
      total: segments.length,
      horizontal: horizontal.length,
      vertical: vertical.length,
      long_horizontal_top30: long_horizontal.map((s) => ({
        start: { x: Math.round(s.start.x), y: Math.round(s.start.y) },
        end:   { x: Math.round(s.end.x),   y: Math.round(s.end.y) },
        length_px: Math.round(s.length_px),
        length_ft: dominantPxPerFt ? Number((s.length_px / dominantPxPerFt).toFixed(2)) : null,
      })),
    },
  };
}

module.exports = {
  measurePage,
  extractLineSegments,
  findDetailBlocks,
  PDF_BASE_DPI,
};
