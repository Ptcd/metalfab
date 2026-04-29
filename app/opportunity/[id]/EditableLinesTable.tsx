"use client";

import { useState } from "react";

export interface EditableLine {
  id: string;
  line_no: number;
  category: string;
  description: string;
  quantity: number;
  quantity_unit: string;
  steel_shape_designation: string | null;
  unit_weight: number | null;
  unit_weight_unit: string | null;
  total_weight_lbs: number | null;
  fab_hrs: number | null;
  det_hrs: number | null;
  foreman_hrs: number | null;
  ironworker_hrs: number | null;
  finish: string | null;
  material_cost_usd: number | null;
  labor_cost_usd: number | null;
  finish_cost_usd: number | null;
  line_total_usd: number | null;
  confidence: number;
  flagged_for_review: boolean;
  assumptions: string | null;
  notes: string | null;
}

const CATEGORIES = [
  'lintel', 'pipe_support', 'hollow_metal_frame', 'bollard', 'embed',
  'stair', 'handrail', 'guardrail', 'ladder', 'misc_metal',
  'structural_beam', 'structural_column', 'base_plate', 'shelf_angle',
  'overhead_door_framing', 'other',
];
const UNITS = ['EA', 'LF', 'SF', 'LBS', 'LS'];
const FINISHES = ['galvanized', 'shop_primer', 'powder_coat', 'none'];

const fmt$ = (v: number | null | undefined) =>
  v == null ? '—' : `$${Math.round(v).toLocaleString()}`;
const fmtNum = (v: number | null | undefined, decimals = 1) =>
  v == null ? '' : Number(v).toFixed(decimals).replace(/\.0+$/, '');

interface Props {
  lines: EditableLine[];
  runId: string;
  opportunityId: string;
  readOnly: boolean;
  onLinesChange: (lines: EditableLine[], run: Record<string, unknown>) => void;
}

export function EditableLinesTable({ lines, runId, opportunityId, readOnly, onLinesChange }: Props) {
  const [savingCell, setSavingCell] = useState<string | null>(null);

  async function patchField(lineId: string, field: keyof EditableLine, value: unknown) {
    setSavingCell(`${lineId}.${field as string}`);
    const res = await fetch(`/api/opportunities/${opportunityId}/takeoff/lines/${lineId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    setSavingCell(null);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert(`Save failed: ${e.error || res.status}`);
      return;
    }
    const body = await res.json();
    onLinesChange(body.data.lines as EditableLine[], body.data.run);
  }

  async function deleteLine(lineId: string) {
    if (!confirm('Delete this line?')) return;
    const res = await fetch(`/api/opportunities/${opportunityId}/takeoff/lines/${lineId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert(`Delete failed: ${e.error || res.status}`);
      return;
    }
    const body = await res.json();
    onLinesChange(body.data.lines as EditableLine[], body.data.run);
  }

  async function addLine(seed: Partial<EditableLine> = {}) {
    const res = await fetch(`/api/opportunities/${opportunityId}/takeoff/lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: runId, ...seed }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert(`Add failed: ${e.error || res.status}`);
      return;
    }
    const body = await res.json();
    onLinesChange(body.data.lines as EditableLine[], body.data.run);
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-slate-500 dark:text-slate-400 border-b-2 border-slate-200 dark:border-slate-700">
            <tr>
              <th className="text-left py-2 pr-2 w-8">#</th>
              <th className="text-left py-2 pr-2 min-w-[100px]">Category</th>
              <th className="text-left py-2 pr-2 min-w-[280px]">Description</th>
              <th className="text-right py-2 pr-2 w-16">Qty</th>
              <th className="text-left py-2 pr-2 w-14">Unit</th>
              <th className="text-left py-2 pr-2 w-24">Shape</th>
              <th className="text-right py-2 pr-2 w-16">Unit wt</th>
              <th className="text-right py-2 pr-2 w-14">FAB</th>
              <th className="text-right py-2 pr-2 w-14">DET</th>
              <th className="text-right py-2 pr-2 w-14">F</th>
              <th className="text-right py-2 pr-2 w-14">IW</th>
              <th className="text-left py-2 pr-2 w-24">Finish</th>
              <th className="text-right py-2 pr-2 w-20">Wt (lbs)</th>
              <th className="text-right py-2 pr-2 w-24">Line $</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="text-slate-700 dark:text-slate-300">
            {lines.map((l) => (
              <tr key={l.id} className={`border-b border-slate-100 dark:border-slate-800 ${l.flagged_for_review ? 'bg-amber-50 dark:bg-amber-900/10' : ''}`}>
                <td className="py-1 pr-2 font-mono text-slate-500">{l.line_no}</td>
                <td className="py-1 pr-2">
                  <Cell
                    value={l.category}
                    options={CATEGORIES}
                    readOnly={readOnly}
                    saving={savingCell === `${l.id}.category`}
                    onSave={(v) => patchField(l.id, 'category', v)}
                  />
                </td>
                <td className="py-1 pr-2">
                  <TextCell
                    value={l.description}
                    readOnly={readOnly}
                    saving={savingCell === `${l.id}.description`}
                    onSave={(v) => patchField(l.id, 'description', v)}
                    title={l.assumptions || undefined}
                  />
                </td>
                <td className="py-1 pr-2">
                  <NumCell
                    value={l.quantity}
                    align="right"
                    readOnly={readOnly}
                    saving={savingCell === `${l.id}.quantity`}
                    onSave={(v) => patchField(l.id, 'quantity', v)}
                  />
                </td>
                <td className="py-1 pr-2">
                  <Cell
                    value={l.quantity_unit}
                    options={UNITS}
                    readOnly={readOnly}
                    saving={savingCell === `${l.id}.quantity_unit`}
                    onSave={(v) => patchField(l.id, 'quantity_unit', v)}
                  />
                </td>
                <td className="py-1 pr-2">
                  <TextCell
                    value={l.steel_shape_designation || ''}
                    readOnly={readOnly}
                    saving={savingCell === `${l.id}.steel_shape_designation`}
                    onSave={(v) => patchField(l.id, 'steel_shape_designation', v || null)}
                  />
                </td>
                <td className="py-1 pr-2">
                  <NumCell
                    value={l.unit_weight}
                    align="right"
                    readOnly={readOnly}
                    saving={savingCell === `${l.id}.unit_weight`}
                    onSave={(v) => patchField(l.id, 'unit_weight', v)}
                  />
                </td>
                <td className="py-1 pr-2">
                  <NumCell value={l.fab_hrs} align="right" readOnly={readOnly} saving={savingCell === `${l.id}.fab_hrs`} onSave={(v) => patchField(l.id, 'fab_hrs', v)} />
                </td>
                <td className="py-1 pr-2">
                  <NumCell value={l.det_hrs} align="right" readOnly={readOnly} saving={savingCell === `${l.id}.det_hrs`} onSave={(v) => patchField(l.id, 'det_hrs', v)} />
                </td>
                <td className="py-1 pr-2">
                  <NumCell value={l.foreman_hrs} align="right" readOnly={readOnly} saving={savingCell === `${l.id}.foreman_hrs`} onSave={(v) => patchField(l.id, 'foreman_hrs', v)} />
                </td>
                <td className="py-1 pr-2">
                  <NumCell value={l.ironworker_hrs} align="right" readOnly={readOnly} saving={savingCell === `${l.id}.ironworker_hrs`} onSave={(v) => patchField(l.id, 'ironworker_hrs', v)} />
                </td>
                <td className="py-1 pr-2">
                  <Cell
                    value={l.finish || ''}
                    options={FINISHES}
                    readOnly={readOnly}
                    saving={savingCell === `${l.id}.finish`}
                    onSave={(v) => patchField(l.id, 'finish', v || null)}
                  />
                </td>
                <td className="py-1 pr-2 text-right text-slate-500">{l.total_weight_lbs?.toFixed(0) ?? '—'}</td>
                <td className="py-1 pr-2 text-right font-mono">{fmt$(l.line_total_usd)}</td>
                <td className="py-1 pr-1 text-right">
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => deleteLine(l.id)}
                      className="text-slate-300 hover:text-red-600 dark:text-slate-600 dark:hover:text-red-400"
                      aria-label="Delete line"
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => addLine()}
            className="px-3 py-1 text-xs rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            + Add line
          </button>
        </div>
      )}
    </div>
  );
}

/* -------- Cell components -------- */

function Cell({ value, options, readOnly, saving, onSave }: {
  value: string;
  options: string[];
  readOnly: boolean;
  saving: boolean;
  onSave: (v: string) => void;
}) {
  if (readOnly) return <span className="text-slate-700 dark:text-slate-300">{value}</span>;
  return (
    <select
      defaultValue={value}
      onBlur={(e) => { if (e.currentTarget.value !== value) onSave(e.currentTarget.value); }}
      className={`bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-blue-500 px-1 py-0.5 rounded text-xs w-full ${saving ? 'opacity-50' : ''}`}
    >
      {!options.includes(value) && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function TextCell({ value, readOnly, saving, onSave, title }: {
  value: string;
  readOnly: boolean;
  saving: boolean;
  onSave: (v: string) => void;
  title?: string;
}) {
  if (readOnly) return <span className="text-slate-700 dark:text-slate-300" title={title}>{value}</span>;
  return (
    <input
      type="text"
      defaultValue={value}
      title={title}
      onBlur={(e) => { if (e.currentTarget.value !== value) onSave(e.currentTarget.value); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
      className={`bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-blue-500 px-1 py-0.5 rounded text-xs w-full ${saving ? 'opacity-50' : ''}`}
    />
  );
}

function NumCell({ value, align, readOnly, saving, onSave }: {
  value: number | null;
  align: 'left' | 'right';
  readOnly: boolean;
  saving: boolean;
  onSave: (v: number | null) => void;
}) {
  const display = value == null ? '' : fmtNum(value, 2);
  if (readOnly) return <span className={align === 'right' ? 'text-right block' : ''}>{display}</span>;
  return (
    <input
      type="text"
      defaultValue={display}
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim();
        const n = raw === '' ? null : Number(raw);
        if (raw !== '' && !Number.isFinite(n)) {
          e.currentTarget.value = display;
          return;
        }
        if (n !== value) onSave(n);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
      className={`bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-blue-500 px-1 py-0.5 rounded text-xs w-full ${align === 'right' ? 'text-right' : ''} ${saving ? 'opacity-50' : ''}`}
    />
  );
}
