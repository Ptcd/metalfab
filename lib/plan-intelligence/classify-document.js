/**
 * classify-document.js — what kind of PDF is this?
 *
 * Classification is the first filter: if a PDF is geotech or a project
 * schedule, we skip it entirely and don't burn Claude calls on it. Uses
 * filename + sampled page text. Conservative: when in doubt, label
 * 'unknown' so the orchestrator can fall through to vision.
 */

const FILENAME_PATTERNS = [
  { kind: 'geotech',     re: /geotech|soil[s]?\s*report|boring/i },
  { kind: 'schedule',    re: /\bschedule|gantt|timeline|milestone/i },
  { kind: 'qa_log',      re: /\bq(?:uestion)?[\s_-]*&?[\s_-]*a(?:nswer)?\b|\brfp[_-]?question|\bclarifications?\b/i },
  { kind: 'addendum',    re: /addend|amendment|revision/i },
  { kind: 'specification', re: /\bspecs?\b|specification|project[\s_-]?manual|statement[\s_-]?of[\s_-]?work|\bsow\b|scope[\s_-]?of[\s_-]?work|bid[\s_-]?scope/i },
  { kind: 'drawing',     re: /\bplan[\s_-]?sheet|drawing|elevation|section|detail|\bsheet\b|permit[\s_-]?set|bid[\s_-]?permit|construction[\s_-]?(?:set|documents?)|\bcd[\s_-]?set/i },
  { kind: 'site_markup', re: /markup|aerial|site[\s_-]?plan/i },
  { kind: 'proposal_form', re: /proposal[\s_-]?form|bid[\s_-]?form/i },
];

const TEXT_PATTERNS = [
  { kind: 'geotech',     re: /geotechnical engineering|standard penetration|soil borin|boring log|atterberg|n[- ]value/i, weight: 3 },
  { kind: 'schedule',    re: /\b(task name|gantt|predecessors|critical path)\b/i, weight: 2 },
  { kind: 'qa_log',      re: /question (and|&) answer|response status|clarifications? log/i, weight: 3 },
  { kind: 'specification', re: /section \d{2}\s\d{2}\s\d{2}\b|csi format|division \d{2}\b/i, weight: 2 },
  { kind: 'drawing',     re: /\bsheet (no|number|#)|\bscale[: ]+1[\/=]|\b(plan|elevation|section|detail) view\b/i, weight: 2 },
];

// Common construction-drawing sheet prefixes. G = General, I = Interior,
// D = Demolition, FP = Fire Protection, FA = Fire Alarm. Order matters
// — multi-letter prefixes must come before their single-letter parents
// so 'FP' beats 'F' when matching.
const SHEET_PREFIXES = ['FP', 'FA', 'A', 'S', 'M', 'P', 'E', 'C', 'L', 'T', 'G', 'I', 'D'];

const { flatText } = require('./page-text');

function joinPageText(page, limit = 4000) {
  // Use shared whitespace-normalized text so regex patterns matching
  // across token boundaries don't get tripped by PDF kerning gaps.
  let s = flatText({ items: page.items.slice(0, 600) });
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

function classifyDocument({ filename, category, pages }) {
  const result = {
    kind: 'unknown',
    confidence: 0,
    reasons: [],
    has_text_layer: pages.some((p) => p.has_text_layer),
    is_raster: pages.every((p) => !p.has_text_layer),
  };

  // Filename pass
  for (const { kind, re } of FILENAME_PATTERNS) {
    if (re.test(filename)) {
      result.kind = kind;
      result.confidence = 60;
      result.reasons.push(`filename matches /${re.source}/`);
      break;
    }
  }

  // Existing category hint from upload
  if (category && category !== 'general' && result.kind === 'unknown') {
    result.kind = category;
    result.confidence = 50;
    result.reasons.push(`upload category=${category}`);
  }

  // Text content pass — only if we have a text layer
  if (result.has_text_layer) {
    const sample = pages.slice(0, 3).map((p) => joinPageText(p, 2000)).join(' ');
    const scores = {};
    for (const { kind, re, weight } of TEXT_PATTERNS) {
      if (re.test(sample)) {
        scores[kind] = (scores[kind] || 0) + weight;
        result.reasons.push(`text matches /${re.source}/ → +${weight} for ${kind}`);
      }
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) {
      // Text content overrides ambiguous filename
      if (result.kind === 'unknown' || result.confidence < 70) {
        result.kind = best[0];
        result.confidence = Math.min(95, 50 + best[1] * 10);
      } else if (best[0] !== result.kind) {
        result.reasons.push(
          `text suggests ${best[0]} but filename said ${result.kind} — keeping filename`
        );
      }
    }
  } else {
    result.reasons.push('no text layer — likely raster scan, OCR required');
    if (result.kind === 'unknown') result.kind = 'raster_scan';
  }

  return result;
}

/**
 * Extract sheet identifier (S101, A201, P501, etc.) from a drawing's
 * title block area — bottom-right corner is the convention. Returns
 * { sheet_no, sheet_title } or empty fields.
 *
 * Some CAD systems render the sheet identifier character-by-character
 * (each glyph as its own text item). To handle that, we both join
 * the items linearly AND cluster nearby characters into single tokens
 * before regex matching.
 */
function extractSheetIdentity(page) {
  if (!page.items.length) return { sheet_no: null, sheet_title: null };

  // Title block is typically the bottom-right ~30% of the sheet
  const cutoffY = page.height * 0.65;
  const cutoffX = page.width * 0.55;
  const tbItems = page.items.filter((it) => it.y >= cutoffY && it.x >= cutoffX);
  const tbText = tbItems.map((it) => it.str).join(' ');

  // Also reconstruct character-cluster tokens. Group items at the same Y
  // (within 4 px) whose x-positions are tight (gap ≤ font_size). Each
  // cluster becomes a single concatenated token. This catches sheet IDs
  // that get split into one-letter items by the CAD renderer.
  const tbClusterTokens = [];
  const sortedTb = [...tbItems].sort((a, b) => a.y - b.y || a.x - b.x);
  let cluster = [];
  for (const it of sortedTb) {
    if (cluster.length === 0) {
      cluster.push(it);
      continue;
    }
    const last = cluster[cluster.length - 1];
    const sameRow = Math.abs(it.y - last.y) <= 4;
    const tightGap = it.x - (last.x + (last.width || 0)) <= Math.max(8, last.font_size || 12);
    if (sameRow && tightGap) {
      cluster.push(it);
    } else {
      tbClusterTokens.push(cluster.map((c) => c.str).join('').trim());
      cluster = [it];
    }
  }
  if (cluster.length) tbClusterTokens.push(cluster.map((c) => c.str).join('').trim());

  let sheet_no = null;
  const re = new RegExp(
    `\\b(${SHEET_PREFIXES.join('|')})[- ]?(\\d{1,3}(?:\\.\\d{1,2})?)\\b`,
    'g'
  );
  // First try the linear text join — covers normal CAD output
  let matches = [...tbText.matchAll(re)];
  if (!matches.length) {
    // Fall back to cluster tokens — covers char-by-char rendered titles
    for (const tok of tbClusterTokens) {
      const m = tok.match(re);
      if (m) { matches = [m[0].match(/(.*)/)]; matches[0][0] = m[0]; break; }
    }
  }
  if (matches.length) {
    sheet_no = matches[0][0].replace(/\s+/g, '').replace('-', '');
  }

  // SHEET TITLE often appears as ALL CAPS labeled "SHEET TITLE" or just
  // the largest text in the title block area. Heuristic: pick the line
  // immediately above the sheet_no with multiple words.
  let sheet_title = null;
  const tbLines = tbText.split(/(?<=[A-Z])\s{2,}/).map((s) => s.trim()).filter(Boolean);
  for (const line of tbLines) {
    if (line.length >= 8 && line.length <= 80 && /[A-Z]/.test(line) &&
        /\s/.test(line) && !/copyright|file no|drawn by|designed/i.test(line)) {
      sheet_title = line;
      break;
    }
  }

  return { sheet_no, sheet_title };
}

module.exports = { classifyDocument, extractSheetIdentity };
