#!/usr/bin/env python3
"""
import-bluebeam-takeoff.py — pull steel shapes and assembly labor priors from
a past Bluebeam-derived xlsx takeoff and push them into the estimator seed
tables (steel_shapes, assembly_labor_priors).

This is a one-off / occasional tool, not a runtime service. Run it whenever
Thomas hands over another historical job xlsx so the catalog and priors
keep growing.

Usage:
  python scripts/import-bluebeam-takeoff.py "<path-to-xlsx>" \
    [--source <tag>] [--dry-run]

The --source tag becomes the provenance label on every row this run inserts
(e.g. 'racine-aquatic-2025-09'). Defaults to a slugged filename.

Reads .env.local for SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Idempotent:
duplicate (designation, unit) shapes and (assembly_type, size_band, source)
priors are skipped, so re-running on the same file is a no-op.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent.parent / '.env.local'
load_dotenv(ENV_PATH)

SUPABASE_URL = os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')

# ----------------------------------------------------------------------------
# Bluebeam template column layout (TAKEOFF sheet, header row 8 in the Gilmore
# template). All other historical templates follow the same Excel-row layout
# because they're saved-as copies of one shop template.
# ----------------------------------------------------------------------------
COL = {
    'dwg_ref':    1,
    'section':    2,
    'item':       3,
    'quantity':   4,
    'pcs':        5,
    'total_qty':  6,
    'unit':       7,
    'unit_wt':    8,
    'total_wt':   9,
    'fab':       10,
    'det':       11,
    'eng':       12,
    'foreman':   13,
    'iw':        14,
    'del':       15,
}

PHASE_HINTS = {
    'stair':            'pan_stair',
    'handrail':         'wall_handrail_run',
    'guardrail':        'guardrail_run',
    'railing':          'guardrail_run',
    'lintel':           'lintel_set',
    'bollard':          'bollard_set',
    'mezzanine':        'mezzanine',
    'hss':              'hss_framing',
    'frame':            'w_framing',
    'partition':        'hss_framing',
}


def slugify(s):
    return re.sub(r'[^a-z0-9-]+', '-', s.lower()).strip('-')


def _has_labor(row):
    """True if any labor / weight column is populated — i.e. this is a totals
    row, not a phase-header row. Real headers have only the dwg cell filled."""
    for k in ('total_wt', 'fab', 'det', 'foreman', 'iw'):
        v = row[COL[k]]
        if not pd.isna(v) and v != 0:
            return True
    return False


def is_phase_header(row):
    dwg = row[COL['dwg_ref']]
    if not isinstance(dwg, str):
        return False
    s = dwg.strip()
    if s.upper().startswith('TOTAL') or s.lower() == 'dwg. ref.':
        return False
    return (
        pd.isna(row[COL['section']])
        and pd.isna(row[COL['item']])
        and not _has_labor(row)
        and any(c.isalpha() for c in s)
    )


def is_total_row(row, current_name):
    """Totals row = no section/item, has labor/weight populated. Either prefixed
    with 'TOTAL' or repeats the current phase name (Bluebeam templates do both)."""
    dwg = row[COL['dwg_ref']]
    if not isinstance(dwg, str):
        return False
    s = dwg.strip()
    if not (pd.isna(row[COL['section']]) and pd.isna(row[COL['item']])):
        return False
    if not _has_labor(row):
        return False
    if s.upper().startswith('TOTAL'):
        return True
    if current_name and s == current_name:
        return True
    return False


def classify_assembly(name):
    """Map a phase name like 'Steel Bollards' to an assembly_type enum."""
    n = name.lower()
    for hint, kind in PHASE_HINTS.items():
        if hint in n:
            return kind
    return 'misc'


def extract_phases(df):
    """Walk TAKEOFF rows and emit one record per phase (header → total)."""
    phases = []
    current = None
    for i in range(len(df)):
        row = df.iloc[i]
        dwg = row[COL['dwg_ref']]
        sec = row[COL['section']]
        item = row[COL['item']]

        # Order matters: totals row first (some templates repeat the phase
        # name on the totals row instead of prefixing 'TOTAL').
        if is_total_row(row, current['name'] if current else None):
            if current is None:
                continue
            current['totals'] = {
                'total_weight':       row[COL['total_wt']],
                'fab_hrs':            row[COL['fab']],
                'det_hrs':            row[COL['det']],
                'eng_hrs':            row[COL['eng']],
                'foreman_hrs':        row[COL['foreman']],
                'ironworker_hrs':     row[COL['iw']],
                'deliveries':         row[COL['del']],
            }
            phases.append(current)
            current = None
            continue

        if is_phase_header(row):
            if current:
                phases.append(current)
            current = {
                'name':   dwg.strip(),
                'lines':  [],
                'totals': None,
            }
            continue

        if current is not None and not pd.isna(item):
            current['lines'].append({
                'dwg':       dwg if not pd.isna(dwg) else None,
                'section':   sec if not pd.isna(sec) else None,
                'item':      item,
                'quantity':  row[COL['quantity']],
                'total_qty': row[COL['total_qty']],
                'unit':      row[COL['unit']],
                'unit_wt':   row[COL['unit_wt']],
                'total_wt':  row[COL['total_wt']],
            })
    return [p for p in phases if p.get('totals')]


def shape_family(designation):
    d = designation.upper()
    if d.startswith('W'):     return 'W'
    if d.startswith('HSS'):   return 'HSS'
    if 'PIPE' in d:           return 'PIPE'
    if d.startswith('L') or 'ANGLE' in d: return 'ANGLE'
    if d.startswith('C') or 'CHANNEL' in d: return 'CHANNEL'
    if 'PL' in d or 'PLATE' in d: return 'PLATE'
    if 'BAR' in d:            return 'BAR'
    return 'CUSTOM'


def normalize_shape_designation(item, section):
    """
    Heuristic shape-naming. Bluebeam takeoffs encode designations a few ways:
      'L2X2X1/4 - 6"L'              → 'L2x2x1/4 - 6\"L'
      '3/8" X12" STRINGER PL'       → 'PL 3/8 x 12'
      '1 1/2" DIA. ST. PIPE'        → '1 1/2\" pipe'
      'W8X10'                        → 'W8x10'
    Falls back to the raw item string when we can't normalize confidently.
    """
    s = str(item).strip()
    s = re.sub(r'\s+', ' ', s)

    m = re.match(r'^[Ww](\d+)[Xx](\d+(?:\.\d+)?)$', s)
    if m: return f'W{m.group(1)}x{m.group(2)}'

    m = re.match(r'^HSS(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)X(\d+/\d+|\d+(?:\.\d+)?)$', s, re.I)
    if m: return f'HSS{m.group(1)}x{m.group(2)}x{m.group(3)}'

    m = re.match(r'^L(\d+(?:[\./]\d+)?)X(\d+(?:[\./]\d+)?)X(\d+/\d+|\d+(?:\.\d+)?)\s*-\s*(.+)$', s, re.I)
    if m: return f'L{m.group(1)}x{m.group(2)}x{m.group(3)} - {m.group(4)}'

    m = re.search(r'(\d+(?:\s*\d+/\d+)?(?:\.\d+)?)["\u201d]\s*DIA', s, re.I)
    if m and 'PIPE' in s.upper():
        sched = ''
        if 'SCH' in s.upper():
            sm = re.search(r'SCH[. ]*(\d+)', s, re.I)
            if sm: sched = f' sch {sm.group(1)}'
        elif 'GA' in s.upper():
            sm = re.search(r'(\d+)\s*GA', s, re.I)
            if sm: sched = f' ({sm.group(1)} GA)'
        return f'{m.group(1).strip()}" pipe{sched}'

    m = re.match(r'^(\d+(?:/\d+)?)["\u201d]?\s*X\s*(\d+)["\u201d]?\s*STRINGER PL$', s, re.I)
    if m: return f'PL {m.group(1)} x {m.group(2)}'

    return s


def build_shape_rows(phases, source):
    seen = {}
    for p in phases:
        for line in p['lines']:
            uw = line['unit_wt']
            unit_label = line['unit']
            if pd.isna(uw) or uw in (0, '0'):
                continue
            if pd.isna(unit_label):
                continue
            unit_label = str(unit_label).strip().upper()
            if unit_label in ('FT', 'LF'):
                unit = 'lb/ft'
            elif unit_label == 'EA':
                unit = 'lb/ea'
            else:
                continue

            designation = normalize_shape_designation(line['item'], line['section'])
            key = (designation, unit)
            if key in seen:
                continue
            seen[key] = {
                'designation':  designation,
                'shape_family': shape_family(designation),
                'unit':         unit,
                'unit_weight':  float(uw),
                'description':  str(line['item']).strip(),
                'aisc_table':   None,
                'source':       source,
            }
    return list(seen.values())


def size_band(weight):
    if weight is None: return None
    if weight < 200:   return 'small'
    if weight < 1500:  return 'medium'
    return 'large'


def build_prior_rows(phases, source):
    rows = []
    for p in phases:
        t = p['totals']
        atype = classify_assembly(p['name'])
        weight = float(t['total_weight']) if not pd.isna(t['total_weight']) else None

        def num(v, default=0):
            try:
                return float(v) if not pd.isna(v) else default
            except (TypeError, ValueError):
                return default

        fab = num(t['fab_hrs'])
        iw = num(t['ironworker_hrs'])

        rows.append({
            'assembly_type':           atype,
            'size_band':               size_band(weight),
            'description':             f"{p['name']}: ~{weight:.0f} lbs (imported from {source})" if weight else p['name'],
            'fab_hrs_expected':        fab,
            'det_hrs_expected':        num(t['det_hrs']),
            'eng_hrs_expected':        num(t['eng_hrs']),
            'foreman_hrs_expected':    num(t['foreman_hrs']),
            'ironworker_hrs_expected': iw,
            'deliveries_expected':     num(t['deliveries']),
            'fab_hrs_min':             round(fab * 0.75, 1) if fab else None,
            'fab_hrs_max':             round(fab * 1.30, 1) if fab else None,
            'ironworker_hrs_min':      round(iw * 0.75, 1) if iw else None,
            'ironworker_hrs_max':      round(iw * 1.30, 1) if iw else None,
            'source':                  source,
            'sample_count':            1,
            'total_weight_lbs':        weight,
        })
    return rows


def post(table, rows, dry_run):
    if not rows:
        print(f'  ({table}) nothing to insert')
        return 0
    if dry_run:
        print(f'  ({table}) [dry-run] would insert {len(rows)} rows')
        for r in rows[:5]:
            print('   ', json.dumps(r, default=str))
        if len(rows) > 5:
            print(f'    ... and {len(rows) - 5} more')
        return len(rows)
    if not SUPABASE_URL or not SUPABASE_KEY:
        print(f'  !! SUPABASE creds missing — skipping {table}', file=sys.stderr)
        return 0
    url = f'{SUPABASE_URL}/rest/v1/{table}'
    headers = {
        'apikey':        SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal,resolution=ignore-duplicates',
    }
    r = requests.post(url, json=rows, headers=headers, timeout=30)
    if r.status_code >= 300:
        print(f'  !! {table} insert failed: HTTP {r.status_code} {r.text}', file=sys.stderr)
        return 0
    print(f'  ({table}) inserted {len(rows)} rows (duplicates ignored)')
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx', help='Path to Bluebeam-derived takeoff xlsx')
    ap.add_argument('--source', help='Provenance tag (default: slug of filename)')
    ap.add_argument('--dry-run', action='store_true', help='Print, do not insert')
    args = ap.parse_args()

    path = Path(args.xlsx)
    if not path.exists():
        print(f'File not found: {path}', file=sys.stderr)
        sys.exit(1)

    source = args.source or slugify(path.stem)
    print(f'Reading: {path.name}')
    print(f'Source tag: {source}')

    df = pd.read_excel(path, sheet_name='TAKEOFF', header=None)
    phases = extract_phases(df)
    print(f'Phases found: {len(phases)}')
    for p in phases:
        t = p['totals']
        print(f'  - {p["name"]:<55} '
              f'fab={t["fab_hrs"]:>5} det={t["det_hrs"]:>4} '
              f'iw={t["ironworker_hrs"]:>5} '
              f'wt={t["total_weight"]:.0f} lbs')

    shapes = build_shape_rows(phases, source)
    priors = build_prior_rows(phases, source)
    print(f'Unique steel_shapes extracted: {len(shapes)}')
    print(f'Assembly priors extracted:     {len(priors)}')
    print()

    print('Inserting into Supabase...' if not args.dry_run else 'Dry run — no writes:')
    post('steel_shapes', shapes, args.dry_run)
    post('assembly_labor_priors', priors, args.dry_run)
    print('Done.')


if __name__ == '__main__':
    main()
