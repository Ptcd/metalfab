/**
 * lib/coverage/tcb-scope-policy.js — single source of truth for what
 * TCB Metalworks bids. The coverage manifest builder consults this
 * file to tag every spec section / plan sheet / schedule as
 * `included | excluded | n_a | needs_human_judgment`.
 *
 * Edit this file — not the manifest builder, not the takeoff prompt —
 * when scope policy changes (e.g. "we now bid Div 10 fire-protection
 * specialties"). Every consumer reads from here.
 *
 * The model deliberately favours rules over heuristics. When a section
 * isn't in any list it gets `needs_human_judgment` rather than being
 * silently dropped. The unresolved queue is the relief valve, not
 * "default to excluded".
 */

// CSI section codes that TCB bids. Each entry has the section code,
// the canonical title, and the takeoff line categories that should
// cover it (used by the validator to enforce reconciliation).
const INCLUDED_SECTIONS = [
  // Division 05 — Metals
  { code: '05 12 00', title: 'Structural Steel Framing',          categories: ['structural_beam', 'structural_column', 'base_plate'] },
  { code: '05 12 13', title: 'Architecturally-Exposed Structural Steel', categories: ['structural_beam', 'structural_column'] },
  { code: '05 21 00', title: 'Steel Joist Framing',               categories: ['structural_beam'] },
  { code: '05 31 00', title: 'Steel Decking',                     categories: ['misc_metal'] },
  { code: '05 50 00', title: 'Metal Fabrications',                categories: ['lintel', 'shelf_angle', 'embed', 'bollard', 'pipe_support', 'misc_metal', 'overhead_door_framing'] },
  { code: '05 51 00', title: 'Metal Stairs',                      categories: ['stair'] },
  { code: '05 51 13', title: 'Metal Pan Stairs',                  categories: ['stair'] },
  { code: '05 51 33', title: 'Metal Ladders',                     categories: ['ladder'] },
  { code: '05 52 00', title: 'Metal Railings',                    categories: ['handrail', 'guardrail'] },
  { code: '05 52 13', title: 'Pipe and Tube Railings',            categories: ['handrail', 'guardrail'] },
  { code: '05 53 00', title: 'Metal Gratings',                    categories: ['misc_metal'] },
  { code: '05 54 00', title: 'Metal Floor Plates',                categories: ['misc_metal'] },
  { code: '05 56 00', title: 'Metal Castings',                    categories: ['misc_metal'] },
  { code: '05 70 00', title: 'Decorative Metal',                  categories: ['misc_metal'] },
  { code: '05 73 00', title: 'Decorative Metal Railings',         categories: ['handrail', 'guardrail'] },
  { code: '05 75 00', title: 'Decorative Formed Metal',           categories: ['misc_metal'] },

  // Division 08 — Openings (the parts TCB carries)
  { code: '08 11 13', title: 'Hollow Metal Doors',                categories: ['hollow_metal_frame'] },
  { code: '08 12 11', title: 'Hollow Metal Frames',               categories: ['hollow_metal_frame'] },
  { code: '08 12 13', title: 'Hollow Metal Frames',               categories: ['hollow_metal_frame'] },
  { code: '08 12 16', title: 'Aluminum Frames',                   categories: ['hollow_metal_frame'] },
  { code: '08 31 00', title: 'Access Doors and Panels',           categories: ['misc_metal'] },
  // Note: 08 36 13 (Sectional/Overhead Doors) — TCB carries the FRAMING
  // around overhead doors, not the doors themselves. The agent must
  // bid only the lintels + jambs and explicitly exclude the door panels.
];

// Sections explicitly NOT in TCB scope. These get tagged `excluded`
// with a reason so the takeoff agent can carry them as exclusions
// in the proposal.
const EXCLUDED_SECTIONS = [
  // Division 03 — Concrete (concrete sub)
  { code: '03 30 00', title: 'Cast-in-Place Concrete',            reason: 'By concrete sub. TCB provides embeds (05 50 00) cast into the concrete; the concrete itself is not TCB scope.' },
  { code: '03 31 00', title: 'Structural Concrete',               reason: 'By concrete sub.' },

  // Division 06 — Wood (wood/casework sub)
  { code: '06 10 00', title: 'Rough Carpentry',                   reason: 'By rough-carpentry sub.' },
  { code: '06 20 00', title: 'Finish Carpentry',                  reason: 'By finish-carpentry / casework sub.' },
  { code: '06 41 00', title: 'Architectural Wood Casework',       reason: 'By casework sub.' },

  // Division 07 — Thermal & Moisture (roofing / waterproofing sub)
  { code: '07 22 00', title: 'Roof and Deck Insulation',          reason: 'By roofing sub.' },
  { code: '07 41 00', title: 'Roof Panels',                       reason: 'By roofing/cladding sub.' },
  { code: '07 42 00', title: 'Wall Panels',                       reason: 'By cladding sub.' },
  { code: '07 50 00', title: 'Membrane Roofing',                  reason: 'By roofing sub.' },
  { code: '07 84 00', title: 'Firestopping',                      reason: 'By firestopping sub.' },
  { code: '07 92 00', title: 'Joint Sealants',                    reason: 'By caulking sub.' },

  // Division 08 — Openings (the parts TCB does NOT carry)
  { code: '08 14 16', title: 'Flush Wood Doors',                  reason: 'By door supplier; TCB provides only the HM frames.' },
  { code: '08 33 23', title: 'Overhead Coiling Doors',            reason: 'By overhead-door sub. TCB provides only the surrounding framing/lintels.' },
  { code: '08 36 13', title: 'Sectional Doors',                   reason: 'Door panels by overhead-door sub. TCB provides surrounding framing.' },
  { code: '08 41 13', title: 'Aluminum-Framed Entrances',         reason: 'By glazing sub.' },
  { code: '08 71 00', title: 'Door Hardware',                     reason: 'By door-hardware sub.' },
  { code: '08 80 00', title: 'Glazing',                           reason: 'By glazing sub.' },

  // Division 09 — Finishes (paint, drywall, flooring subs)
  { code: '09 05 61', title: 'Common Work Results for Flooring',  reason: 'By flooring sub.' },
  { code: '09 21 16', title: 'Gypsum Board Assemblies',           reason: 'By drywall sub.' },
  { code: '09 22 16', title: 'Non-Structural Metal Framing',      reason: 'Light-gauge framing (cold-formed metal studs) by drywall sub, not TCB structural metals.' },
  { code: '09 30 00', title: 'Tiling',                            reason: 'By tile sub.' },
  { code: '09 51 00', title: 'Acoustical Ceilings',               reason: 'By ACT sub.' },
  { code: '09 65 00', title: 'Resilient Flooring',                reason: 'By flooring sub.' },
  { code: '09 91 00', title: 'Painting',                          reason: 'Field paint by paint sub. TCB provides shop primer per spec.' },
  { code: '09 91 13', title: 'Exterior Painting',                 reason: 'By paint sub.' },
  { code: '09 91 23', title: 'Interior Painting',                 reason: 'By paint sub.' },

  // Division 10 — Specialties (specialty subs unless explicitly noted)
  { code: '10 11 00', title: 'Visual Display Units',              reason: 'By specialty sub.' },
  { code: '10 14 00', title: 'Signage',                           reason: 'By signage sub.' },
  { code: '10 21 13', title: 'Toilet Compartments',               reason: 'By toilet-partition sub.' },
  { code: '10 22 13', title: 'Wire Mesh Partitions',              reason: 'By specialty sub.' },
  { code: '10 26 00', title: 'Wall and Door Protection',          reason: 'By specialty sub.' },
  { code: '10 28 00', title: 'Toilet, Bath, and Laundry Accessories', reason: 'By specialty sub.' },
  { code: '10 44 00', title: 'Fire Protection Specialties',       reason: 'By fire-extinguisher sub.' },
  { code: '10 51 13', title: 'Metal Lockers',                     reason: 'By locker sub. Commodity item, not TCB.' },
  { code: '10 56 00', title: 'Storage Assemblies',                reason: 'By specialty sub.' },

  // Division 11 — Equipment (equipment sub or owner-supplied)
  { code: '11 30 13', title: 'Residential Appliances',            reason: 'By owner / appliance sub.' },
  { code: '11 53 00', title: 'Laboratory Equipment',              reason: 'By lab-equipment sub.' },

  // Division 12 — Furnishings
  { code: '12 24 00', title: 'Window Shades',                     reason: 'By shade sub.' },
  { code: '12 36 00', title: 'Countertops',                       reason: 'By casework sub.' },

  // Division 22/23/26/27/28 — MEP / FP / IT / Security
  { code: '22 00 00', title: 'Plumbing',                          reason: 'By plumbing sub.' },
  { code: '23 00 00', title: 'HVAC',                              reason: 'By HVAC sub.' },
  { code: '26 00 00', title: 'Electrical',                        reason: 'By electrical sub.' },
  { code: '27 00 00', title: 'Communications',                    reason: 'By low-voltage sub.' },
  { code: '28 00 00', title: 'Electronic Safety and Security',    reason: 'By security sub.' },

  // Division 31/32/33 — Sitework / Earthwork / Utilities
  { code: '31 00 00', title: 'Earthwork',                         reason: 'By sitework sub.' },
  { code: '32 00 00', title: 'Exterior Improvements',             reason: 'By sitework sub.' },
  { code: '32 31 13', title: 'Chain-Link Fences and Gates',       reason: 'By fence sub.' },
  { code: '33 00 00', title: 'Utilities',                         reason: 'By utility sub.' },
];

// Divisions that get auto-tagged `n_a` if a section in them appears
// and isn't otherwise explicitly listed. Used to keep `needs_human_judgment`
// from getting flooded by clearly-out-of-scope divisions.
const NA_DIVISION_PREFIXES = ['00', '01', '02', '13', '14', '21', '25', '34', '35', '40', '41', '42', '43', '44', '45', '46', '48'];

// Drawing sheet prefixes and their disciplines, with default coverage
// stance for TCB. Per-sheet included/excluded comes from this PLUS the
// sheet's content (e.g. an A-sheet with a door schedule is `included`,
// but most A-sheets are `n_a` for a structural-metals takeoff).
const SHEET_DISCIPLINE_DEFAULTS = {
  G: { discipline: 'general',       default_tag: 'included',              reason: 'General notes / project info — must be read for scope-affecting callouts.' },
  C: { discipline: 'civil',          default_tag: 'n_a',                   reason: 'Civil — outside TCB scope unless an embed/bollard callout appears.' },
  L: { discipline: 'landscape',      default_tag: 'n_a',                   reason: 'Landscape — outside TCB scope.' },
  S: { discipline: 'structural',     default_tag: 'included',              reason: 'Structural — primary source for steel framing scope.' },
  A: { discipline: 'architectural',  default_tag: 'needs_human_judgment',  reason: 'Architectural — schedules and details may include TCB scope (door schedule, frame schedule, miscellaneous metals).' },
  I: { discipline: 'interior',       default_tag: 'n_a',                   reason: 'Interior elevations — usually no TCB scope.' },
  M: { discipline: 'mechanical',     default_tag: 'n_a',                   reason: 'Mechanical — TCB does not bid HVAC supports unless explicitly noted.' },
  P: { discipline: 'plumbing',       default_tag: 'n_a',                   reason: 'Plumbing — TCB does not bid pipe supports unless explicitly noted.' },
  E: { discipline: 'electrical',     default_tag: 'n_a',                   reason: 'Electrical — out of TCB scope.' },
  T: { discipline: 'telecom',        default_tag: 'n_a',                   reason: 'Telecom / IT — out of TCB scope.' },
  D: { discipline: 'demolition',     default_tag: 'excluded',              reason: 'Demolition — not TCB scope (D-series sheets carry existing-to-remove items).' },
  Q: { discipline: 'equipment',      default_tag: 'needs_human_judgment',  reason: 'Equipment — may include TCB-scope items like bollards or embeds.' },
  FP: { discipline: 'fire_protection', default_tag: 'n_a',                 reason: 'Fire protection — out of TCB scope.' },
};

// Schedule kinds (as emitted by lib/plan-intelligence/parse-schedule.js)
// and their default tag.
const SCHEDULE_DEFAULTS = {
  door_schedule:      { tag: 'included', reason: 'Door schedule — primary source for hollow_metal_frame counts.' },
  frame_schedule:     { tag: 'included', reason: 'Frame schedule — primary source for HM frame quantities and types.' },
  lintel_schedule:    { tag: 'included', reason: 'Lintel schedule — primary source for lintel sizing and counts.' },
  hardware_schedule:  { tag: 'excluded', reason: 'Hardware schedule — by door-hardware sub.' },
  finish_schedule:    { tag: 'n_a',      reason: 'Finish schedule — finishes by paint/finish subs.' },
  equipment_schedule: { tag: 'needs_human_judgment', reason: 'Equipment schedule — may include TCB-scope items (E60 BOLLARD, embeds, etc.).' },
  embed_schedule:     { tag: 'included', reason: 'Embed schedule — TCB scope per 05 50 00.' },
  // Default for unknown schedule kinds:
  __default:          { tag: 'needs_human_judgment', reason: 'Unknown schedule kind — review whether contents affect TCB scope.' },
};

function divisionPrefix(code) {
  const m = String(code || '').match(/^(\d{2})/);
  return m ? m[1] : null;
}

function sheetPrefix(sheetNo) {
  // FP-001 must match before F-001; longest prefix wins.
  const s = String(sheetNo || '').toUpperCase().replace(/\s+/g, '');
  if (s.startsWith('FP')) return 'FP';
  const m = s.match(/^([A-Z]+)/);
  return m ? m[1].slice(0, 1) : null;   // first letter only for single-letter prefixes
}

/**
 * Tag a CSI spec section. Returns:
 *   { tag, reason, expected_categories?, source: 'policy' }
 * Tag is one of: 'included' | 'excluded' | 'n_a' | 'needs_human_judgment'
 */
function tagSpecSection({ code, title }) {
  const inc = INCLUDED_SECTIONS.find((s) => s.code === code);
  if (inc) return { tag: 'included', reason: `${inc.title} — TCB scope per policy.`, expected_categories: inc.categories, source: 'policy' };

  const exc = EXCLUDED_SECTIONS.find((s) => s.code === code);
  if (exc) return { tag: 'excluded', reason: exc.reason, source: 'policy' };

  // Match by division-prefix to NA divisions
  const div = divisionPrefix(code);
  if (div && NA_DIVISION_PREFIXES.includes(div)) {
    return { tag: 'n_a', reason: `Division ${div} — outside TCB scope.`, source: 'policy' };
  }

  // Two-digit prefix matches in EXCLUDED_SECTIONS (e.g. '23 00 00' covers
  // any 23-division section the spec book happens to use)
  if (div) {
    const divLevel = EXCLUDED_SECTIONS.find((s) => divisionPrefix(s.code) === div && s.code.endsWith('00 00'));
    if (divLevel) return { tag: 'excluded', reason: divLevel.reason, source: 'policy' };
  }

  return {
    tag: 'needs_human_judgment',
    reason: `Section ${code}${title ? ` (${title})` : ''} not in TCB scope policy. Add to lib/coverage/tcb-scope-policy.js (INCLUDED_SECTIONS or EXCLUDED_SECTIONS) after deciding scope.`,
    source: 'unmatched',
  };
}

/**
 * Tag a plan sheet by its sheet_no + per-sheet text density.
 * `lowTextContent` — true if the sheet's text-extraction came back
 * suspiciously thin (boilerplate-only). Drives the `needs_vision` flag.
 *
 * Returns:
 *   { tag, reason, needs_vision, vision_reason?, source: 'policy' }
 */
function tagPlanSheet({ sheet_no, sheet_title, item_count, has_text_layer }) {
  const prefix = sheetPrefix(sheet_no);
  const def = SHEET_DISCIPLINE_DEFAULTS[prefix] || {
    discipline: 'unknown',
    default_tag: 'needs_human_judgment',
    reason: `Sheet prefix "${prefix}" unknown. Add to SHEET_DISCIPLINE_DEFAULTS in lib/coverage/tcb-scope-policy.js.`,
  };

  const lowTextContent = has_text_layer === true && (item_count == null || item_count < 80);
  const noTextLayer    = has_text_layer === false;

  // Vision is required when:
  //  - a sheet that we want to read (included) has thin text content, OR
  //  - any sheet that we'd otherwise default to needs_human_judgment, OR
  //  - the sheet has no text layer at all (raster).
  let needs_vision = false;
  let vision_reason = null;
  if (def.default_tag === 'included' && (lowTextContent || noTextLayer)) {
    needs_vision = true;
    vision_reason = noTextLayer
      ? 'No text layer — raster sheet. Vision required.'
      : `Text extraction returned only ${item_count} items (likely title-block boilerplate only). Vision required to read sheet contents.`;
  } else if (def.default_tag === 'needs_human_judgment') {
    needs_vision = true;
    vision_reason = 'Sheet may contain TCB scope; vision read required to confirm in/out of scope.';
  }

  return {
    tag: def.default_tag,
    reason: def.reason + (sheet_title ? ` Sheet title: "${sheet_title}".` : ''),
    discipline: def.discipline,
    needs_vision,
    vision_reason,
    source: 'policy',
  };
}

/** Tag a schedule by its kind. */
function tagSchedule({ kind }) {
  const def = SCHEDULE_DEFAULTS[kind] || SCHEDULE_DEFAULTS.__default;
  return { tag: def.tag, reason: def.reason, source: 'policy' };
}

/** Categories expected for a given list of included spec sections. */
function expectedCategoriesForSections(sectionCodes) {
  const set = new Set();
  for (const code of sectionCodes) {
    const inc = INCLUDED_SECTIONS.find((s) => s.code === code);
    if (inc) for (const c of inc.categories) set.add(c);
  }
  return [...set];
}

module.exports = {
  INCLUDED_SECTIONS,
  EXCLUDED_SECTIONS,
  NA_DIVISION_PREFIXES,
  SHEET_DISCIPLINE_DEFAULTS,
  SCHEDULE_DEFAULTS,
  tagSpecSection,
  tagPlanSheet,
  tagSchedule,
  expectedCategoriesForSections,
  divisionPrefix,
  sheetPrefix,
};
