"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ScoringConfig } from "@/types/scoring";

interface Props {
  config: ScoringConfig;
}

export function ConfigEditor({ config }: Props) {
  const router = useRouter();
  const [data, setData] = useState(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);

    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyword_primary: data.keyword_primary,
        keyword_secondary: data.keyword_secondary,
        keyword_disqualify: data.keyword_disqualify,
        naics_codes: data.naics_codes,
        dollar_min: data.dollar_min,
        dollar_max: data.dollar_max,
        score_green: data.score_green,
        score_yellow: data.score_yellow,
        qa_analysis_enabled: data.qa_analysis_enabled,
        qa_min_score_threshold: data.qa_min_score_threshold,
        estimator_email: data.estimator_email,
        owner_email: data.owner_email,
        doc_retention_won_days: data.doc_retention_won_days,
        doc_retention_lost_days: data.doc_retention_lost_days,
      }),
    });

    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "Failed to save");
    } else {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    }

    setSaving(false);
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      <TagListField
        label="Primary Keywords (+20)"
        value={data.keyword_primary}
        onChange={(v) => setData({ ...data, keyword_primary: v })}
      />

      <TagListField
        label="Secondary Keywords (+10)"
        value={data.keyword_secondary}
        onChange={(v) => setData({ ...data, keyword_secondary: v })}
      />

      <TagListField
        label="Disqualifying Keywords (-15)"
        value={data.keyword_disqualify}
        onChange={(v) => setData({ ...data, keyword_disqualify: v })}
      />

      <TagListField
        label="NAICS Codes"
        value={data.naics_codes}
        onChange={(v) => setData({ ...data, naics_codes: v })}
      />

      <div className="grid grid-cols-2 gap-4">
        <NumberField
          label="Dollar Min"
          value={data.dollar_min}
          onChange={(v) => setData({ ...data, dollar_min: v })}
        />
        <NumberField
          label="Dollar Max"
          value={data.dollar_max}
          onChange={(v) => setData({ ...data, dollar_max: v })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <NumberField
          label="Green Score Threshold"
          value={data.score_green}
          onChange={(v) => setData({ ...data, score_green: v })}
        />
        <NumberField
          label="Yellow Score Threshold"
          value={data.score_yellow}
          onChange={(v) => setData({ ...data, score_yellow: v })}
        />
      </div>

      {/* QA Layer settings */}
      <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-3">
          QA Layer (Claude Code analysis + digest)
        </h3>

        {(!data.estimator_email || !data.owner_email) && (
          <div className="mb-4 p-3 rounded-md bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-sm border border-amber-200 dark:border-amber-900/40">
            <strong>Digest will fail until you fill in both emails below.</strong>
            <br />
            {!data.estimator_email && <span>• Estimator email is empty — nobody will receive the daily digest.<br /></span>}
            {!data.owner_email && <span>• Owner email is empty — failure alerts have nowhere to go.<br /></span>}
          </div>
        )}

        <div className="flex items-center gap-2 mb-4">
          <input
            id="qa_enabled"
            type="checkbox"
            checked={data.qa_analysis_enabled}
            onChange={(e) => setData({ ...data, qa_analysis_enabled: e.target.checked })}
            className="rounded"
          />
          <label htmlFor="qa_enabled" className="text-sm text-slate-700 dark:text-slate-300">
            QA analysis enabled (promote passing opportunities to <code>awaiting_qa</code>)
          </label>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <NumberField
            label="QA min score threshold"
            value={data.qa_min_score_threshold}
            onChange={(v) => setData({ ...data, qa_min_score_threshold: v })}
          />
          <div />
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <TextField
            label="Estimator email (digest recipient)"
            value={data.estimator_email ?? ""}
            onChange={(v) => setData({ ...data, estimator_email: v || null })}
          />
          <TextField
            label="Owner email (CC + alerts)"
            value={data.owner_email ?? ""}
            onChange={(v) => setData({ ...data, owner_email: v || null })}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <NumberField
            label="Doc retention — won (days)"
            value={data.doc_retention_won_days}
            onChange={(v) => setData({ ...data, doc_retention_won_days: v })}
          />
          <NumberField
            label="Doc retention — lost (days)"
            value={data.doc_retention_lost_days}
            onChange={(v) => setData({ ...data, doc_retention_lost_days: v })}
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Config"}
        </button>
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>}
      </div>
    </div>
  );
}

function TagListField({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState("");

  function addTag() {
    const tag = input.trim();
    if (tag && !value.includes(tag)) {
      onChange([...value, tag]);
    }
    setInput("");
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-700 text-sm text-slate-700 dark:text-slate-300"
          >
            {tag}
            <button
              onClick={() => removeTag(tag)}
              className="text-slate-400 hover:text-red-500 ml-0.5"
            >
              &times;
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          placeholder="Type and press Enter"
          className="flex-1 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-1.5 text-sm text-slate-900 dark:text-white"
        />
        <button
          onClick={addTag}
          type="button"
          className="px-3 py-1.5 rounded-md text-sm bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-500"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
      />
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
      />
    </div>
  );
}
