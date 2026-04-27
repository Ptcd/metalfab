"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Customer } from "@/types/opportunity";
import { uploadOneFile } from "@/lib/upload-document";

interface Props {
  onClose: () => void;
  /** Pre-populate from a dropped PDF (filename stub, etc.) */
  initial?: {
    title?: string;
    description?: string;
    droppedFiles?: File[];
  };
}

export function AddOpportunityModal({ onClose, initial }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [pickedCustomer, setPickedCustomer] = useState<Customer | null>(null);
  const [searchedCustomers, setSearchedCustomers] = useState(false);
  const [runQa, setRunQa] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [files, setFiles] = useState<File[]>(initial?.droppedFiles || []);

  // Customer search
  useEffect(() => {
    if (!customerQuery.trim()) { setCustomerResults([]); setSearchedCustomers(false); return; }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(customerQuery)}`);
      if (res.ok) {
        const { data } = await res.json();
        setCustomerResults(data || []);
        setSearchedCustomers(true);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [customerQuery]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const form = new FormData(e.currentTarget);
    const body = {
      title: form.get("title"),
      agency: form.get("agency") || null,
      description: form.get("description") || null,
      dollar_min: form.get("dollar_min") ? Number(form.get("dollar_min")) : null,
      dollar_max: form.get("dollar_max") ? Number(form.get("dollar_max")) : null,
      estimated_value: form.get("estimated_value") ? Number(form.get("estimated_value")) : null,
      response_deadline: form.get("response_deadline") || null,
      source_url: form.get("source_url") || null,
      notes: form.get("notes") || null,
      referrer: form.get("referrer") || null,
      confidence: form.get("confidence") || null,
      added_by: form.get("added_by") || null,
      customer_id: pickedCustomer?.id || null,
      source: pickedCustomer?.company || form.get("agency") || 'manual',
      source_channel: pickedCustomer ? 'referral' : 'manual',
      added_via: files.length > 0 ? 'pdf-drop' : 'quick-add',
      status: runQa && files.length > 0 ? 'awaiting_qa' : 'reviewing',
    };

    const res = await fetch("/api/opportunities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to save");
      setSaving(false);
      return;
    }

    const { data: opp } = await res.json();

    // Upload each file (uploadOneFile handles >4 MB via signed direct upload)
    for (const f of files) {
      const lower = f.name.toLowerCase();
      let category: string = "general";
      if (/spec/.test(lower)) category = "specification";
      else if (/drawing|plan|sheet/.test(lower)) category = "drawing";
      else if (/addendum|amendment/.test(lower)) category = "addendum";
      else if (/form|checklist/.test(lower)) category = "form";
      else if (/proposal|quote/.test(lower)) category = "proposal";
      else if (/takeoff/.test(lower)) category = "takeoff";
      else if (/shop.*drawing|submittal/.test(lower)) category = "shop_drawing";

      const result = await uploadOneFile(opp.id, f, category);
      if (!result) {
        console.error("upload failed for", f.name);
      }
    }

    router.refresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Add Opportunity</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xl">&times;</button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
          <Field label="Title *" name="title" required defaultValue={initial?.title} />

          {/* Customer picker */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Customer / GC (referral source)
            </label>
            {pickedCustomer ? (
              <div className="flex items-center gap-2 rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/20 px-3 py-2">
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-900 dark:text-white">{pickedCustomer.name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{pickedCustomer.company || pickedCustomer.email || "—"}</p>
                </div>
                <button type="button" onClick={() => setPickedCustomer(null)} className="text-xs text-red-600 hover:underline">Clear</button>
              </div>
            ) : (
              <div className="relative">
                <input
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  placeholder="Search existing customers…"
                  className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                />
                {customerQuery && (
                  <div className="absolute z-10 left-0 right-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {customerResults.length === 0 && searchedCustomers ? (
                      <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                        No matches —{" "}
                        <a
                          href="/customers?new=1"
                          target="_blank"
                          className="text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          create customer →
                        </a>
                      </div>
                    ) : (
                      customerResults.map((c) => (
                        <button
                          type="button"
                          key={c.id}
                          onClick={() => { setPickedCustomer(c); setCustomerQuery(""); setCustomerResults([]); }}
                          className="w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-sm"
                        >
                          <span className="font-medium text-slate-900 dark:text-white">{c.name}</span>
                          {c.company && <span className="text-slate-500 dark:text-slate-400"> · {c.company}</span>}
                        </button>
                      ))
                    )}
                  </div>
                )}
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Not in the list? <a href="/customers?new=1" target="_blank" className="text-blue-600 dark:text-blue-400 hover:underline">Create one →</a>
                </p>
              </div>
            )}
          </div>

          <Field label="Agency / Client (if different from customer)" name="agency" />
          <TextArea label="Description" name="description" defaultValue={initial?.description} />

          <div className="grid grid-cols-3 gap-3">
            <Field label="Bid Min $" name="dollar_min" type="number" />
            <Field label="Bid Max $" name="dollar_max" type="number" />
            <Field label="TCB Est. $" name="estimated_value" type="number" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Deadline" name="response_deadline" type="datetime-local" />
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Confidence</label>
              <select
                name="confidence"
                className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
              >
                <option value="">—</option>
                <option value="hot">Hot (very likely)</option>
                <option value="warm">Warm (worth a look)</option>
                <option value="cold">Cold (long shot)</option>
              </select>
            </div>
          </div>

          <Field label="Source URL" name="source_url" type="url" />
          <Field label="Referrer (name / note)" name="referrer" placeholder="e.g. Mike at CD Smith" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Added by</label>
              <select
                name="added_by"
                className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
              >
                <option value="colin">Colin</option>
                <option value="gohar">Gohar</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <TextArea label="Notes" name="notes" />

          {/* File picker */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Attach documents (PDFs, drawings, specs, shop drawings, proposals…)
            </label>
            <input
              type="file"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
              className="w-full text-sm"
            />
            {files.length > 0 && (
              <ul className="mt-2 text-xs text-slate-600 dark:text-slate-400 space-y-0.5">
                {files.map((f, i) => (
                  <li key={i}>• {f.name} ({Math.round(f.size / 1024)} KB)</li>
                ))}
              </ul>
            )}
          </div>

          {/* QA flag */}
          <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={runQa}
              onChange={(e) => setRunQa(e.target.checked)}
              disabled={files.length === 0}
              className="mt-0.5"
            />
            <span>
              Queue for AI analysis (Claude Code will review the docs)
              {files.length === 0 && <span className="text-slate-400"> — requires at least one attached file</span>}
            </span>
          </label>

          <div className="flex justify-end gap-3 pt-2 border-t border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? (files.length > 0 ? `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…` : "Saving...") : "Add Opportunity"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label, name, type = "text", required = false, defaultValue, placeholder,
}: { label: string; name: string; type?: string; required?: boolean; defaultValue?: string; placeholder?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">{label}</label>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
      />
    </div>
  );
}

function TextArea({ label, name, defaultValue }: { label: string; name: string; defaultValue?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">{label}</label>
      <textarea
        name={name}
        rows={3}
        defaultValue={defaultValue}
        className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
      />
    </div>
  );
}
