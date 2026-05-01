/**
 * lib/plan-intelligence/extract-geometry.js — pull vector line
 * segments out of every drawing page so plan-intelligence can do
 * automatic measurement without a vision call.
 *
 * Why this exists: text extraction misses everything that isn't text.
 * Wall lines, rail lines, room outlines, dimension lines, partition
 * runs — all are vector graphics in the PDF content stream. PlanBeam
 * and similar takeoff tools work because they let you click those
 * vectors. We can read them directly via pdfjs OPS without a click.
 *
 * Output (one entry per page):
 *   {
 *     page_number, width, height,
 *     segments_at_render_scale_4: [
 *       { start_px: {x,y}, end_px: {x,y}, length_px, orientation },
 *       ...
 *     ]
 *   }
 *
 * Pixels are computed at pdf-to-img scale=4 (288 DPI on Arch D),
 * matching the auto-render output. The agent or validator can then
 * convert px → ft using the detail's scale (parseDrawingScale).
 */

const { getDocument } = require('pdfjs-dist');

const RENDER_SCALE = 4;
const MIN_LINE_LENGTH_PX = 200;          // ~14" at 1/2"=1'-0", filters tick marks
const ORIENTATION_TOLERANCE = 0.05;       // dy/dx ratio threshold

// pdfjs OPS constants (constants exported by pdfjs-dist)
let _OPS = null;
function ops() {
  if (_OPS) return _OPS;
  try {
    _OPS = require('pdfjs-dist').OPS;
  } catch (_) { /* fall through */ }
  if (!_OPS) {
    // Hardcoded fallback — these values are stable across pdfjs 3-4 majors
    _OPS = {
      moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17,
      closePath: 18, rectangle: 19, constructPath: 91,
    };
  }
  return _OPS;
}

function classifyOrientation(dx, dy) {
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx < 0.1 && ady < 0.1) return 'point';
  if (ady / (adx + 0.001) < ORIENTATION_TOLERANCE) return 'horizontal';
  if (adx / (ady + 0.001) < ORIENTATION_TOLERANCE) return 'vertical';
  return 'diagonal';
}

/**
 * Walk a constructPath operator's inner ops array, emitting line
 * segments. Curves and unknown ops are skipped — we only emit straight
 * line segments.
 */
function emitSegmentsFromPath(innerOps, args, viewport, out) {
  const O = ops();
  let argIdx = 0;
  let cursor = null;
  let pathStart = null;
  for (const op of innerOps) {
    if (op === O.moveTo) {
      const x = args[argIdx++], y = args[argIdx++];
      cursor = { x, y };
      pathStart = { x, y };
    } else if (op === O.lineTo) {
      const x = args[argIdx++], y = args[argIdx++];
      if (cursor) emitOne(cursor, { x, y }, viewport, out);
      cursor = { x, y };
    } else if (op === O.closePath) {
      if (cursor && pathStart) emitOne(cursor, pathStart, viewport, out);
    } else if (op === O.rectangle) {
      const x = args[argIdx++], y = args[argIdx++];
      const w = args[argIdx++], h = args[argIdx++];
      const c = [
        { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
      ];
      for (let k = 0; k < 4; k++) emitOne(c[k], c[(k + 1) % 4], viewport, out);
      cursor = { x, y };
      pathStart = { x, y };
    } else if (op === O.curveTo)  { argIdx += 6; cursor = null; }
    else if (op === O.curveTo2)   { argIdx += 4; cursor = null; }
    else if (op === O.curveTo3)   { argIdx += 4; cursor = null; }
    else {
      // Unknown op — abandon this path to avoid arg-misalignment
      return;
    }
  }
}

function emitOne(p1, p2, viewport, out) {
  const [x1, y1] = viewport.convertToViewportPoint(p1.x, p1.y);
  const [x2, y2] = viewport.convertToViewportPoint(p2.x, p2.y);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < MIN_LINE_LENGTH_PX) return;
  out.push({
    start_px: { x: Math.round(x1), y: Math.round(y1) },
    end_px:   { x: Math.round(x2), y: Math.round(y2) },
    length_px: Math.round(len),
    orientation: classifyOrientation(dx, dy),
  });
}

/**
 * Extract vector geometry from every page of a PDF.
 *
 * Returns array of { page_number, width, height, segments }.
 * Segments are reported in pixel coordinates at RENDER_SCALE so they
 * line up with the auto-rendered PNGs.
 */
async function extractGeometry(buffer, { onlyPages = null } = {}) {
  // pdfjs is strict — it rejects Node Buffer even though it's a Uint8Array
  // subclass. Force a copy into a fresh Uint8Array.
  const data = new Uint8Array(buffer);
  const doc = await getDocument({
    data, disableFontFace: true, useSystemFonts: false,
    isEvalSupported: false, verbosity: 0,
  }).promise;

  const O = ops();
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (onlyPages && !onlyPages.has(i)) continue;
    let page;
    try { page = await doc.getPage(i); } catch (_) { continue; }
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    let segments = [];
    try {
      const opList = await page.getOperatorList();
      const fnArray = opList.fnArray;
      const argsArray = opList.argsArray;
      for (let j = 0; j < fnArray.length; j++) {
        if (fnArray[j] === O.constructPath) {
          // pdfjs constructPath args: [opsArray, argsArray, ...]
          const inner = argsArray[j];
          const innerOps = inner[0];
          const innerArgs = inner[1];
          emitSegmentsFromPath(innerOps, innerArgs, viewport, segments);
        }
      }
    } catch (_) {
      // Some pages throw on getOperatorList (font issues etc.) — skip
      // measurement on that page rather than fail the whole pass
    }
    out.push({
      page_number: i,
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      segments_count: segments.length,
      // Cap at 200 longest segments per page — that's plenty for
      // measurement and keeps the persisted summary lean
      segments: segments.sort((a, b) => b.length_px - a.length_px).slice(0, 200),
    });
    page.cleanup();
  }
  await doc.destroy();
  return { render_scale: RENDER_SCALE, pages: out };
}

module.exports = { extractGeometry, RENDER_SCALE, MIN_LINE_LENGTH_PX };
