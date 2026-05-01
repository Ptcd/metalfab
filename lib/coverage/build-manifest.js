/**
 * lib/coverage/build-manifest.js — deterministic builder that turns a
 * plan-intelligence digest into a coverage manifest.
 *
 * The manifest is the single artifact the takeoff agent must reconcile
 * against. Every `included` entry must end up either covered by a
 * takeoff line or carried as an explicit intentional exclusion. The
 * `manifest_coverage` validator enforces this at commit time.
 *
 * Key design choices:
 *   - No AI in this stage. All tagging is rule-based via tcb-scope-policy.js.
 *   - Items the policy can't tag go to `unresolved[]`, not silently dropped.
 *   - Plan sheets with thin text extraction get `needs_vision: true`.
 *     This kills the G900–G910 failure class (sheets that were
 *     classified blank but actually contain spec content).
 *   - Schedules + sheets + sections all use the same `tag` vocabulary
 *     so the validator can iterate uniformly.
 */

const {
  tagSpecSection,
  tagPlanSheet,
  tagSchedule,
  expectedCategoriesForSections,
} = require('./tcb-scope-policy');

const MANIFEST_VERSION = 'manifest-v1';

/**
 * Pull the spec section list out of the digest. Plan-intelligence's
 * `summary.tcb_sections[]` only includes the ~20 codes in its
 * hardcoded TCB_SECTION_LABELS table — anything else gets dropped.
 *
 * For the manifest we want EVERY section header that appeared in the
 * spec book, even ones outside TCB scope, so they can be carried as
 * explicit exclusions. This walks the per-doc text and extracts every
 * `SECTION NN NN NN TITLE` heading.
 *
 * Falls back to summary.tcb_sections when per-doc text isn't available
 * (e.g. when reading a persisted digest).
 */
function enumerateSpecSections(digest) {
  const found = new Map();   // code -> { code, title, source_filename, first_page }

  // Preferred path: walk full text per spec doc when _pages is present
  // (only available when called from the same process as plan-intelligence).
  for (const d of digest.documents || []) {
    if (d.classification?.kind !== 'specification' && d.classification?.kind !== 'addendum') continue;
    const pages = d._pages || [];
    for (const p of pages) {
      const text = (p.items || []).map((i) => i.str).join(' ');
      // CSI 6-digit code: "SECTION 05 12 00 STRUCTURAL STEEL FRAMING"
      // Allow optional period after SECTION, hyphenated codes, and
      // 2-digit + 2-digit + 2-digit with single-space separators.
      const re = /\b(?:SECTION|DOCUMENT)\s*[:\-.]?\s*(\d{2}[\s\-.]\d{2}[\s\-.]\d{2})\b\s*([A-Z][A-Z0-9 ,&\-/]{2,80})?/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const code = m[1].replace(/[\s.\-]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/^\d{2} \d{2} \d{2}$/.test(code)) continue;
        if (found.has(code)) continue;
        const title = (m[2] || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
        found.set(code, {
          code,
          title,
          source_filename: d.filename,
          first_page: p.page_number,
        });
      }
    }
  }

  // Fallback: persisted summary.tcb_sections (always present)
  for (const s of (digest.summary?.tcb_sections || [])) {
    const code = s.section;
    if (found.has(code)) continue;
    found.set(code, {
      code,
      title: s.label || null,
      source_filename: s.source_filename || null,
      first_page: s.first_page ?? null,
    });
  }

  return [...found.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** Per-doc list of plan sheets with text-density signals. */
function enumeratePlanSheets(digest) {
  const out = [];
  for (const d of digest.documents || []) {
    if (d.classification?.kind !== 'drawing') continue;
    for (const s of d.sheets || []) {
      out.push({
        sheet_no:       s.sheet_no || null,
        sheet_title:    s.sheet_title || null,
        page_number:    s.page_number,
        item_count:     s.item_count ?? null,
        has_text_layer: s.has_text_layer === true,
        source_filename: d.filename,
        schedules_found: s.schedules_found || 0,
      });
    }
  }
  return out;
}

/** Per-package schedule list (already aggregated in summary). */
function enumerateSchedules(digest) {
  return (digest.summary?.schedules || []).map((s) => ({
    kind:            s.kind,
    page_number:     s.page_number,
    source_filename: s.source_filename,
    row_count:       s.row_count ?? null,
    headers:         s.headers || [],
  }));
}

/**
 * Build the manifest. Pure function: deterministic given the digest.
 *
 * Returns:
 *   {
 *     version, generated_at,
 *     spec_sections: [...],   each: { code, title, tag, reason, expected_categories?, source_filename, first_page }
 *     plan_sheets:   [...],   each: { sheet_no, sheet_title, page_number, tag, reason, needs_vision, vision_reason?, discipline, source_filename }
 *     schedules:     [...],   each: { kind, page_number, source_filename, tag, reason, row_count }
 *     unresolved:    [...],   each: { kind, ref, reason }
 *     summary: { included_count, excluded_count, na_count, needs_human_judgment_count, needs_vision_count }
 *     expected_categories: [...]   union of expected_categories for all `included` spec_sections
 *   }
 */
function buildManifest(digest) {
  const specSections = enumerateSpecSections(digest).map((s) => {
    const t = tagSpecSection({ code: s.code, title: s.title });
    return {
      ...s,
      tag: t.tag,
      reason: t.reason,
      expected_categories: t.expected_categories || [],
      source: t.source,
    };
  });

  const planSheets = enumeratePlanSheets(digest).map((s) => {
    const t = tagPlanSheet({
      sheet_no:       s.sheet_no,
      sheet_title:    s.sheet_title,
      item_count:     s.item_count,
      has_text_layer: s.has_text_layer,
    });
    return {
      ...s,
      tag: t.tag,
      reason: t.reason,
      discipline: t.discipline,
      needs_vision: t.needs_vision,
      vision_reason: t.vision_reason,
      source: t.source,
    };
  });

  const schedules = enumerateSchedules(digest).map((s) => {
    const t = tagSchedule({ kind: s.kind });
    return { ...s, tag: t.tag, reason: t.reason, source: t.source };
  });

  const unresolved = [];
  for (const s of specSections) {
    if (s.tag === 'needs_human_judgment') {
      unresolved.push({
        kind: 'spec_section',
        ref: s.code,
        title: s.title,
        first_page: s.first_page,
        source_filename: s.source_filename,
        reason: s.reason,
      });
    }
  }
  for (const s of planSheets) {
    if (s.tag === 'needs_human_judgment') {
      unresolved.push({
        kind: 'plan_sheet',
        ref: s.sheet_no || `p${s.page_number}`,
        title: s.sheet_title,
        page_number: s.page_number,
        source_filename: s.source_filename,
        needs_vision: s.needs_vision,
        reason: s.reason,
      });
    }
  }
  for (const s of schedules) {
    if (s.tag === 'needs_human_judgment') {
      unresolved.push({
        kind: 'schedule',
        ref: s.kind,
        page_number: s.page_number,
        source_filename: s.source_filename,
        reason: s.reason,
      });
    }
  }

  const counts = (items) => ({
    included: items.filter((i) => i.tag === 'included').length,
    excluded: items.filter((i) => i.tag === 'excluded').length,
    n_a: items.filter((i) => i.tag === 'n_a').length,
    needs_human_judgment: items.filter((i) => i.tag === 'needs_human_judgment').length,
  });

  const includedSectionCodes = specSections.filter((s) => s.tag === 'included').map((s) => s.code);
  const expectedCategories = expectedCategoriesForSections(includedSectionCodes);

  const summary = {
    spec_sections: counts(specSections),
    plan_sheets:   counts(planSheets),
    schedules:     counts(schedules),
    needs_vision_count: planSheets.filter((s) => s.needs_vision).length,
    unresolved_count: unresolved.length,
  };

  return {
    version:    MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    spec_sections: specSections,
    plan_sheets:   planSheets,
    schedules,
    unresolved,
    summary,
    expected_categories: expectedCategories,
  };
}

module.exports = {
  MANIFEST_VERSION,
  buildManifest,
  enumerateSpecSections,
  enumeratePlanSheets,
  enumerateSchedules,
};
