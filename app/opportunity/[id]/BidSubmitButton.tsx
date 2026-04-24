"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function BidSubmitButton({ oppId, gcEmail }: { oppId: string; gcEmail?: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch(`/api/opportunities/${oppId}/bid-submissions`, {
      method: "POST",
      body: fd,
    });
    const body = await res.json();
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      router.refresh();
    } else {
      setErr(body.error || `HTTP ${res.status}`);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium"
      >
        Record bid submission
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">Record bid submission</h3>
              <button
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-xl"
              >
                &times;
              </button>
            </div>

            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              Flips status to Bidding, saves the proposal PDF, and creates 3-day
              and 10-day follow-up reminders.
            </p>

            {err && (
              <div className="mb-3 p-3 rounded-md bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
                {err}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    TCB bid amount *
                  </label>
                  <input
                    type="number"
                    name="amount_usd"
                    required
                    min="1"
                    step="1"
                    placeholder="e.g. 127000"
                    className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Submitted by
                  </label>
                  <select
                    name="submitted_by"
                    defaultValue="colin"
                    className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                  >
                    <option value="colin">Colin</option>
                    <option value="gohar">Gohar</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Method
                  </label>
                  <select
                    name="method"
                    defaultValue="email"
                    className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                  >
                    <option value="email">Email</option>
                    <option value="portal">Portal upload</option>
                    <option value="phone">Phone / in person</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    GC contact email
                  </label>
                  <input
                    type="email"
                    name="gc_contact_email"
                    defaultValue={gcEmail ?? ""}
                    placeholder="mike@cdsmith.com"
                    className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Proposal PDF (optional)
                </label>
                <input
                  type="file"
                  name="proposal"
                  accept="application/pdf,.pdf,.docx,.xlsx"
                  className="w-full text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Saved under the opportunity&apos;s documents as a Proposal artifact.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Notes
                </label>
                <textarea
                  name="notes"
                  rows={3}
                  placeholder="e.g. bid covers Div 05 structural steel only, excludes hollow metal"
                  className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="px-4 py-2 rounded-md text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {busy ? "Recording..." : "Record bid"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
