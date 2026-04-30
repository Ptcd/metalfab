/**
 * parse-bid-form.js — read the GC's bid form to learn what CSI codes
 * the takeoff is allowed to populate.
 *
 * GCs publish a bid form (xlsx or PDF) that lists the CSI line items
 * they want priced. If `05 50 00 Metal Fabrications` isn't on it,
 * misc-metals shouldn't be a takeoff line — it has nowhere to land
 * in the GC's compilation. The bid-form CSI list becomes the
 * authoritative scope envelope: takeoff line categories that map to
 * codes outside this envelope are phantom items.
 *
 * Supports xlsx via the existing tooling pattern (pandas via Python
 * subprocess if present; otherwise heuristic text scan of any PDF
 * the user uploaded as the form).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// CSI category → likely takeoff_lines.category. Used to map the
// bid-form's listed CSI codes back into "is this takeoff line allowed?"
const CSI_TO_CATEGORY = {
  '05 10 00': ['structural_beam', 'structural_column', 'base_plate'],
  '05 12 00': ['structural_beam', 'structural_column', 'base_plate'],
  '05 21 00': ['structural_beam'],            // joists
  '05 30 00': [],                              // metal decking — typically not TCB
  '05 40 00': ['misc_metal'],                  // cold-formed framing (RTU frames, etc)
  '05 50 00': ['lintel', 'shelf_angle', 'embed', 'bollard', 'pipe_support', 'misc_metal', 'overhead_door_framing'],
  '05 51 00': ['stair'],                       // metal stairs
  '05 51 13': ['stair'],
  '05 51 33': ['ladder'],
  '05 52 00': ['handrail', 'guardrail'],
  '05 53 00': ['misc_metal'],                  // gratings
  '05 54 00': ['misc_metal'],                  // floor plates
  '05 73 00': ['handrail', 'guardrail'],       // decorative railings
  '05 75 00': ['misc_metal'],                  // decorative metal
  '08 11 13': ['hollow_metal_frame'],
  '08 12 11': ['hollow_metal_frame'],
  '08 12 13': ['hollow_metal_frame'],
  '08 36 13': ['overhead_door_framing'],
  // 08 00 00 (catch-all door category) — covers HM frames in many GC bid forms
  '08 00 00': ['hollow_metal_frame'],
  // 05 00 00 (catch-all metals) — covers most TCB scope
  '05 00 00': ['lintel', 'shelf_angle', 'embed', 'bollard', 'pipe_support', 'misc_metal', 'overhead_door_framing', 'structural_beam', 'structural_column', 'base_plate', 'stair', 'handrail', 'guardrail', 'hollow_metal_frame'],
  // 32 series — Site Improvements often covers exterior/site bollards,
  // security gates, fences. Many GC forms put bollards under 32 even
  // when 05 50 00 is absent. Triggered the false-phantom on Nestle.
  '32 00 00': ['bollard', 'guardrail', 'misc_metal'],   // generic site improvements
  '32 31 00': ['guardrail', 'misc_metal'],              // fences and gates
  '32 39 00': ['bollard'],                              // manufactured site specialties
};

// Keyword-based recovery: if a bid form line's description literally
// mentions a takeoff category (e.g., "Site Improvements - Concrete
// Paving, Bollards, Security Gates"), that line covers that category
// regardless of its CSI code. Defeats the false-phantom failure mode
// where a covered scope item was flagged because its CSI didn't map.
const DESCRIPTION_KEYWORD_TO_CATEGORY = {
  bollard:           [/\bBOLLARDS?\b/i],
  guardrail:         [/\bGUARD\s*RAILS?\b/i, /\bRAILINGS?\b/i, /\bSECURITY\s+GATES?\b/i, /\bGATES?\b/i],
  handrail:          [/\bHAND\s*RAILS?\b/i, /\bRAILINGS?\b/i],
  hollow_metal_frame:[/\b(?:HM|HOLLOW\s+METAL)\s+(?:DOOR\s+)?FRAMES?\b/i, /\bDOORS?\s+(?:&|AND)\s+FRAMES?\b/i],
  lintel:            [/\bLINTELS?\b/i],
  embed:             [/\bEMBED(?:DED)?\s+PLATES?\b/i],
  ladder:            [/\bLADDERS?\b/i],
  stair:             [/\bSTAIRS?\b/i, /\bSTAIRWAYS?\b/i],
  structural_beam:   [/\bSTRUCTURAL\s+STEEL\b/i, /\bMETAL\s+FRAMING\b/i],
  misc_metal:        [/\bMISC(?:ELLANEOUS)?\s+METALS?\b/i, /\bMETAL\s+FABRICATION\b/i],
};

const CSI_RE = /\b(\d{2})\s+(\d{2})\s+(\d{2})\b/g;

/**
 * Extract CSI codes from xlsx bid form via Python subprocess.
 * Returns array of { code, description, found_at }.
 */
function parseXlsxBidForm(filepath) {
  // Write the helper to a temp file to avoid quote-escaping pain on
  // Windows + cross-platform shells.
  const py = [
    'import pandas as pd, json, sys, re',
    'codes = []',
    'xl = pd.read_excel(sys.argv[1], sheet_name=None, header=None)',
    'pat = re.compile(r"\\b(\\d{2})\\s+(\\d{2})\\s+(\\d{2})\\b")',
    'for name, df in xl.items():',
    '    for i in range(len(df)):',
    '        row = df.iloc[i]',
    '        cells = [str(v) for v in row.values if pd.notna(v)]',
    '        text = " | ".join(cells)',
    '        for m in pat.finditer(text):',
    '            code = m.group(1) + " " + m.group(2) + " " + m.group(3)',
    '            codes.append({"code": code, "description": text[:140], "sheet": name, "row": i})',
    'print(json.dumps(codes))',
  ].join('\n');
  const tmpScript = path.join(require('os').tmpdir(), `bidform-parse-${Date.now()}.py`);
  fs.writeFileSync(tmpScript, py);
  try {
    const out = execSync(`python "${tmpScript}" "${filepath}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (e) {
    console.error('parseXlsxBidForm failed:', e.message?.slice(0, 200));
    return [];
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
}

/**
 * Extract CSI codes from PDF bid form via the existing extract-text.
 */
async function parsePdfBidForm(buffer) {
  const { extractText } = require('./extract-text');
  const pages = await extractText(buffer);
  const codes = [];
  const { flatText } = require('./page-text');
  for (const p of pages) {
    const text = flatText(p);
    for (const m of text.matchAll(CSI_RE)) {
      codes.push({
        code: `${m[1]} ${m[2]} ${m[3]}`,
        description: text.slice(Math.max(0, m.index - 30), m.index + 80).replace(/\s+/g, ' '),
        page: p.page_number,
      });
    }
  }
  return codes;
}

/**
 * Build the allowed-categories envelope from a bid-form CSI code list.
 * If the form lists `05 00 00` we open the gate to all 05 categories;
 * otherwise we only allow the specific subcodes listed.
 */
function allowedCategoriesFromCsi(csiCodes) {
  const allowed = new Set();
  for (const item of csiCodes) {
    const code = typeof item === 'string' ? item : item.code;
    const desc = typeof item === 'string' ? '' : (item.description || '');

    // Static CSI map
    const cats = CSI_TO_CATEGORY[code];
    if (cats) cats.forEach((c) => allowed.add(c));

    // Description-based override — when the bid form explicitly names
    // the category in the line description (e.g. "Bollards", "Gates"),
    // that line covers it regardless of which CSI code it sits under.
    if (desc) {
      for (const [cat, patterns] of Object.entries(DESCRIPTION_KEYWORD_TO_CATEGORY)) {
        if (patterns.some((re) => re.test(desc))) allowed.add(cat);
      }
    }
  }
  return [...allowed];
}

/**
 * Cross-check takeoff line categories against the bid-form envelope.
 * Returns { in_scope[], phantom[], finding[] }.
 */
function crossCheckTakeoffCategories(takeoffLineCategories, csiCodes) {
  const allowed = new Set(allowedCategoriesFromCsi(csiCodes));
  const csiList = csiCodes.map((c) => c.code);

  const inScope = [];
  const phantom = [];
  for (const cat of takeoffLineCategories) {
    if (allowed.has(cat)) inScope.push(cat);
    else phantom.push(cat);
  }

  const findings = [];
  for (const cat of [...new Set(phantom)]) {
    findings.push({
      severity: 'warning',
      category: 'bid_form_gap',
      finding: `Scope item '${cat}' is in the takeoff but the GC's bid form has no CSI line where it could land. Form lists only: ${csiList.slice(0, 8).join(', ')}${csiList.length > 8 ? '…' : ''}.`,
      // Prior behavior was to suggest dropping the line. New behavior:
      // surface as REQUIRED-RFI to the GC. Silently dropping a real
      // scope item because the GC bid form was incomplete is worse
      // than the line itself — it just hides the problem.
      recommendation: `RFI to GC: "Bid form has no line for '${cat}' (would normally be priced under 05 50 00 or similar). Where should ${cat} scope be priced? Roll into existing line (#7 Structural Steel?) or alternate?"`,
      auto_rfi: true,
    });
  }

  return {
    bid_form_csi_codes: csiList,
    allowed_categories: [...allowed],
    takeoff_categories: [...new Set(takeoffLineCategories)],
    in_scope: [...new Set(inScope)],
    phantom: [...new Set(phantom)],
    findings,
  };
}

/**
 * Audit each bid-form row whose CSI maps to TCB scope: did the takeoff
 * either price it or exclude it explicitly? Silent omission of a TCB-
 * relevant form line means the bid is incomplete in a way the validator
 * suite hasn't been catching.
 *
 * @param {Object[]} csiCodes      — bid form rows [{code, description, ...}]
 * @param {string[]} takeoffCategories — distinct line categories carried
 * @param {string[]} exclusions    — strings from takeoff.exclusions
 *
 * Returns array of findings for rows that are TCB-relevant but undecided.
 */
function auditBidFormLineCoverage(csiCodes, takeoffCategories, exclusions) {
  const exclusionsBlob = (exclusions || []).join(' ').toLowerCase();
  const carriedCats = new Set(takeoffCategories);
  const findings = [];

  for (const row of csiCodes || []) {
    const code = typeof row === 'string' ? row : row.code;
    const desc = typeof row === 'string' ? '' : (row.description || '');
    if (!code) continue;

    // Compute the TCB categories this row could cover
    const csiCats = CSI_TO_CATEGORY[code] || [];
    const descCats = [];
    for (const [cat, patterns] of Object.entries(DESCRIPTION_KEYWORD_TO_CATEGORY)) {
      if (patterns.some((re) => re.test(desc))) descCats.push(cat);
    }
    const possibleCats = [...new Set([...csiCats, ...descCats])];
    if (possibleCats.length === 0) continue;        // not TCB territory; skip

    // Decided if (a) at least one possible category is carried in takeoff,
    // OR (b) the form code or any descriptor token appears in exclusions.
    const carriedAny = possibleCats.some((c) => carriedCats.has(c));
    if (carriedAny) continue;
    const codeMentioned = exclusionsBlob.includes(code.toLowerCase());
    const descTokens = (desc.match(/\b[A-Z][a-z]+\b/g) || []).slice(0, 6);
    const descMentioned = descTokens.length > 0 && descTokens.some((t) => exclusionsBlob.includes(t.toLowerCase()));
    if (codeMentioned || descMentioned) continue;

    findings.push({
      severity: 'warning',
      category: 'bid_form_line_undecided',
      finding: `Bid form row "${code} ${desc.slice(0, 80)}${desc.length > 80 ? '...' : ''}" maps to TCB-relevant categor(ies) [${possibleCats.join(', ')}] but the takeoff neither prices it nor explicitly excludes it.`,
      recommendation: `Decide explicitly: (a) add a takeoff line under ${code}, OR (b) add to exclusions[] with rationale (e.g., "${code} — by door/hardware sub" or "${code} — owner self-perform"). Silent omission risks the GC interpreting your number as covering scope it doesn't.`,
      related_takeoff_line: null,
    });
  }
  return findings;
}

module.exports = { parseXlsxBidForm, parsePdfBidForm, allowedCategoriesFromCsi, crossCheckTakeoffCategories, auditBidFormLineCoverage };
