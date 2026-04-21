"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Customer } from "@/types/opportunity";

type Enriched = Customer & {
  _counts: { total: number; won: number; lost: number; bidding: number; active: number };
};

interface Props {
  customers: Enriched[];
}

export function CustomersClient({ customers }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [showModal, setShowModal] = useState(searchParams.get("new") === "1");

  useEffect(() => {
    setShowModal(searchParams.get("new") === "1");
  }, [searchParams]);

  const filtered = customers.filter((c) => {
    if (roleFilter && c.role !== roleFilter) return false;
    if (!filter) return true;
    const hay = `${c.name} ${c.company ?? ""} ${c.email ?? ""}`.toLowerCase();
    return hay.includes(filter.toLowerCase());
  });

  return (
    <>
      <div className="flex gap-3 mb-4">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search name / company / email"
          className="flex-1 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
        >
          <option value="">All roles</option>
          <option value="GC">GC</option>
          <option value="architect">Architect</option>
          <option value="owner">Owner</option>
          <option value="referral">Referral</option>
          <option value="other">Other</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 py-8 text-center">
          {customers.length === 0
            ? "No customers yet. Add the first one to start tracking."
            : "No matches for that filter."}
        </p>
      ) : (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
          {filtered.map((c) => (
            <Link
              key={c.id}
              href={`/customers/${c.id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">{c.name}</p>
                  {c.role && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                      {c.role}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {c.company && <span>{c.company} · </span>}
                  {c.email || c.phone || "—"}
                </p>
              </div>
              <div className="flex items-center gap-4 shrink-0 ml-4">
                {c._counts.total > 0 ? (
                  <div className="text-right text-xs">
                    <div className="text-slate-900 dark:text-white font-semibold">
                      {c._counts.total} opps
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {c._counts.active > 0 && `${c._counts.active} active · `}
                      {c._counts.won}w / {c._counts.lost}l
                    </div>
                  </div>
                ) : (
                  <span className="text-xs text-slate-400">no opps yet</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {showModal && (
        <CustomerModal
          onClose={() => {
            setShowModal(false);
            router.replace("/customers");
          }}
          onSaved={() => router.refresh()}
        />
      )}
    </>
  );
}

function CustomerModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        company: form.get("company") || null,
        email: form.get("email") || null,
        phone: form.get("phone") || null,
        role: form.get("role") || null,
        notes: form.get("notes") || null,
      }),
    });
    if (!res.ok) {
      const b = await res.json();
      setError(b.error || "Failed to save");
      setSaving(false);
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">New Customer</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
        </div>
        {error && (
          <div className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Name *" name="name" required />
          <Field label="Company" name="company" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email" name="email" type="email" />
            <Field label="Phone" name="phone" type="tel" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Role</label>
            <select
              name="role"
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
            >
              <option value="">—</option>
              <option value="GC">GC (General Contractor)</option>
              <option value="architect">Architect</option>
              <option value="owner">Owner / End Client</option>
              <option value="referral">Referral source</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Notes</label>
            <textarea
              name="notes"
              rows={2}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving..." : "Save Customer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, name, type = "text", required = false }: { label: string; name: string; type?: string; required?: boolean }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">{label}</label>
      <input
        name={name}
        type={type}
        required={required}
        className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
      />
    </div>
  );
}
