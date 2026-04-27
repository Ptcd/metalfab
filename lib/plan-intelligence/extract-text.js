/**
 * extract-text.js — per-page text extraction with positions.
 *
 * Returns an array of pages. Each page is { page_number, width, height,
 * has_text_layer, items: [{ str, x, y, width, height, font_size }] }.
 *
 * Coordinates are in PDF points (1/72"), origin = top-left after we flip
 * pdfjs's bottom-left convention. Width/height are sheet dimensions.
 *
 * Why this matters: Plan Intelligence needs more than `pdf-parse`'s flat
 * string. To find a title block scale we want text near the bottom-right
 * corner; to detect schedules we want items aligned in columns. Bounding
 * boxes make those queries tractable.
 */

let _pdfjs = null;
async function pdfjs() {
  if (!_pdfjs) _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

async function extractText(buffer) {
  const { getDocument } = await pdfjs();
  const data = new Uint8Array(buffer);
  const doc = await getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({
      includeMarkedContent: false,
      disableCombineTextItems: false,
    });

    const items = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const tx = it.transform;
      // pdfjs transform = [a,b,c,d,e,f]; e,f = origin x,y in PDF user space
      // (bottom-left). Convert to top-left.
      const x = tx[4];
      const yBottom = tx[5];
      const fontHeight = Math.hypot(tx[2], tx[3]) || it.height || 0;
      const y = viewport.height - yBottom - fontHeight;
      items.push({
        str: it.str,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        width: Math.round((it.width || 0) * 100) / 100,
        height: Math.round(fontHeight * 100) / 100,
        font_size: Math.round(fontHeight * 10) / 10,
      });
    }

    page.cleanup();

    pages.push({
      page_number: i,
      width: Math.round(viewport.width * 100) / 100,
      height: Math.round(viewport.height * 100) / 100,
      has_text_layer: items.length > 0,
      item_count: items.length,
      items,
    });
  }

  await doc.destroy();
  return pages;
}

module.exports = { extractText };
