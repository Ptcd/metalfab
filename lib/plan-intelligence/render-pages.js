/**
 * lib/plan-intelligence/render-pages.js — render selected drawing pages
 * as high-resolution PNGs so the takeoff agent can do vision-based
 * review (symbol counts, fab detail reads, schedule scans).
 *
 * Why: text extraction from pdfjs misses 80% of what's on a drawing —
 * symbol counts, dimension chain layouts, partition geometry, fine print
 * in detail blocks. Visual review on Nestle caught a 60% bollard count
 * miss (5 → 8) that no text-only validator could detect.
 *
 * Selection logic: render pages most likely to need visual inspection:
 *   - Cover sheet (drawing index)
 *   - Pages with multi-block details (sheet_detail_counts ≥ 2)
 *   - Pages flagged in category_pages for any TCB-relevant category
 *   - Pages with schedules (door, equipment, etc.)
 *   - Pages with elevations (interior elevations are bollard/rail count gold)
 *
 * Output: writes PNGs to <queueDir>/renders/p<N>.png. Manifest at
 * <queueDir>/renders/manifest.json describes what was rendered + why.
 *
 * The takeoff agent's prompt directs it to Read these PNGs when text
 * evidence is ambiguous.
 */

const fs = require('fs');
const path = require('path');

const RENDER_SCALE = 4;        // 4× = ~600 DPI; readable down to ~1/16" callouts
const MAX_PAGES_TO_RENDER = 30; // budget guard — rendering 79 pages takes 5 min

/**
 * Pick which pages to render based on plan-intelligence summary.
 *
 * @param {Object} summary           — plan_intelligence.summary
 * @param {number} drawingPageCount  — total pages in the drawing PDF
 * @returns {Array<{page: number, reason: string}>}
 */
function selectRenderTargets(summary, drawingPageCount) {
  const reasons = new Map(); // page → reasons set

  function add(page, reason) {
    if (!Number.isFinite(page) || page < 1 || page > drawingPageCount) return;
    if (!reasons.has(page)) reasons.set(page, new Set());
    reasons.get(page).add(reason);
  }

  // Cover sheet — drawing index reads better visually than via title-block parsing
  add(1, 'cover_sheet');

  // SPECIFICATIONS / GENERAL NOTES sheets — these often have CAD text
  // rendered as vector outlines, which means pdfjs text extraction
  // misses ALL the spec content. We MUST render these visually so the
  // agent can read them. Discovered as a real systemic miss on Nestle:
  // G900-G910 looked "blank" to text extraction but contain the full
  // Division 00-10 project manual.
  const PROMISED_CONTENT_RE = /\b(SPECIFICATIONS?|GENERAL\s+NOTES?|GEN\.\s+NOTES?)\b/i;
  for (const s of summary.sheets || []) {
    const title = s.sheet_title || '';
    const indexTitle = (summary.drawing_index?.sheets || [])
      .find((idx) => String(idx.number).toUpperCase() === String(s.sheet_no || '').toUpperCase())?.name || '';
    if (PROMISED_CONTENT_RE.test(title) || PROMISED_CONTENT_RE.test(indexTitle)) {
      add(s.page_number, `spec_or_general_notes_sheet`);
    }
  }

  // Pages with multi-block details (sheets typically rich in fab detail)
  const sheetCounts = summary.sheet_detail_counts || {};
  const sheetNoToPage = new Map();
  for (const s of summary.sheets || []) {
    if (s.sheet_no && s.page_number) sheetNoToPage.set(s.sheet_no.toUpperCase(), s.page_number);
  }
  for (const [sheetNo, count] of Object.entries(sheetCounts)) {
    if (count >= 2) {
      const page = sheetNoToPage.get(String(sheetNo).toUpperCase());
      if (page) add(page, `multi_detail_${count}_blocks`);
    }
  }

  // Pages flagged as relevant for TCB-relevant categories. We want
  // breadth (don't miss a category entirely) and we specifically want
  // the LAST page per category — that's typically the interior
  // elevations sheet where visual symbol counting pays off most. Take
  // first 2 + last 1 for each category to balance budget vs coverage.
  const categoryPages = summary.category_pages || {};
  const TCB_CATS = ['bollard', 'guardrail', 'handrail', 'hollow_metal_frame', 'structural_beam',
                    'structural_column', 'base_plate', 'stair', 'lintel', 'embed', 'ladder'];
  for (const cat of TCB_CATS) {
    const pages = categoryPages[cat] || [];
    if (pages.length === 0) continue;
    // First 2 (typically schedule + plan view)
    for (const p of pages.slice(0, 2)) add(p, `${cat}_content`);
    // Last (typically the elevations sheet — highest vision value)
    if (pages.length > 2) add(pages[pages.length - 1], `${cat}_elevation`);
  }

  // Schedule pages
  for (const sch of summary.schedules || []) {
    if (sch.page_number) add(sch.page_number, `schedule_${sch.kind || 'unknown'}`);
  }

  // Convert to sorted list, capped at budget
  const out = [...reasons.entries()]
    .map(([page, reasonSet]) => ({ page, reason: [...reasonSet].join('+') }))
    .sort((a, b) => a.page - b.page);

  return out.slice(0, MAX_PAGES_TO_RENDER);
}

/**
 * Render the selected pages. Uses pdf-to-img (which wraps pdfjs +
 * canvas-equivalent) at RENDER_SCALE.
 *
 * @param {string} pdfPath          — absolute path to drawing PDF
 * @param {Array<{page: number, reason: string}>} targets
 * @param {string} outputDir        — directory to write p<N>.png files
 */
async function renderPages(pdfPath, targets, outputDir) {
  if (!targets.length) return [];
  fs.mkdirSync(outputDir, { recursive: true });

  // Dynamic import — pdf-to-img is ESM
  const { pdf } = await import('pdf-to-img');
  const pageNumberSet = new Set(targets.map((t) => t.page));
  const maxPage = Math.max(...pageNumberSet);

  const rendered = [];
  let i = 0;
  for await (const pageBuffer of await pdf(pdfPath, { scale: RENDER_SCALE })) {
    i++;
    if (pageNumberSet.has(i)) {
      const outPath = path.join(outputDir, `p${i}.png`);
      fs.writeFileSync(outPath, pageBuffer);
      const target = targets.find((t) => t.page === i);
      rendered.push({ page: i, path: outPath, size_bytes: pageBuffer.length, reason: target.reason });
    }
    if (i >= maxPage) break;
  }
  return rendered;
}

/**
 * One-shot helper: select + render + write manifest. Called from the
 * plan-intelligence pipeline OR standalone via scripts.
 */
async function autoRenderForOpp({ summary, pdfPath, queueDir, drawingPageCount }) {
  const targets = selectRenderTargets(summary, drawingPageCount);
  if (!targets.length) return { rendered: [], manifest_path: null };

  const renderDir = path.join(queueDir, 'renders');
  const rendered = await renderPages(pdfPath, targets, renderDir);

  const manifest = {
    generated_at: new Date().toISOString(),
    pdf_source: path.basename(pdfPath),
    render_scale: RENDER_SCALE,
    page_count: drawingPageCount,
    rendered_count: rendered.length,
    pages: rendered.map((r) => ({
      page: r.page,
      filename: path.basename(r.path),
      size_kb: Math.round(r.size_bytes / 1024),
      reason: r.reason,
    })),
  };
  const manifestPath = path.join(renderDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { rendered, manifest_path: manifestPath };
}

module.exports = { selectRenderTargets, renderPages, autoRenderForOpp, RENDER_SCALE };
