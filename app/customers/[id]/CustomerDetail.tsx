"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Customer, OpportunityStatus } from "@/types/opportunity";
import { StatusBadge } from "../../components/StatusBadge";

interface OppSummary {
  id: string;
  title: string;
  status: OpportunityStatus;
  score: number;
  response_deadline: string | null;
  estimated_value: number | null;
  updated_at: string;
  agency: string | null;
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDollars(n: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function CustomerDetail({
  customer: initial,
  opportunities,
}: {
  customer: Customer;
  opportunities: OppSummary[];
}) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [loggingContact, setLoggingContact] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function save(patch: Partial<Customer>) {
    const res = await fetch(`/api/customers/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Save failed: ${body.error || res.status}`);
      return false;
    }
    const { data } = await res.json();
    setC(data);
    router.refresh();
    return true;
  }

  async function handleDelete() {
    if (!confirm(`Delete ${c.name}? Opps linked to them will unlink (not delete).`)) return;
    const res = await fetch(`/api/customers/${c.id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/customers");
    } else {
      alert("Delete failed");
    }
  }

  const wonValue = opportunities
    .filter((o) => o.status === "won")
    .reduce((sum, o) => sum + (o.estimated_value || 0), 0);

  return (
    <div className="max-w-4xl">
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-md shadow-lg">
          ✓ {toast}
        </div>
      )}

      <Link
        href="/customers"
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline mb-4 inline-block"
      >
        ← All customers
      </Link>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{c.name}</h2>
          <p className="text-slate-500 dark:text-slate-400">
            {c.company && <span>{c.company}</span>}
            {c.role && (
              <span className="ml-2 text-xs font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700">
                {c.role}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setLoggingContact(true)}
            className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
          >
            + Log contact
          </button>
          <button
            onClick={() => setEditing(true)}
            className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 text-sm"
          >
            Edit
          </button>
        </div>
      </div>

      {/* Contact */}
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 mb-6 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">Email</p>
          <p className="text-slate-900 dark:text-white">
            {c.email ? (
              <a href={`mailto:${c.email}`} className="text-blue-600 hover:underline">
                {c.email}
              </a>
            ) : (
              "—"
            )}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">Phone</p>
          <p className="text-slate-900 dark:text-white">
            {c.phone ? (
              <a href={`tel:${c.phone}`} className="text-blue-600 hover:underline">
                {c.phone}
              </a>
            ) : (
              "—"
            )}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">First seen</p>
          <p className="text-slate-900 dark:text-white">{fmtDate(c.first_seen)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">Last contact</p>
          <p className="text-slate-900 dark:text-white">{fmtDate(c.last_contact)}</p>
        </div>
      </div>

      {c.notes && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-lg p-4 mb-6">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 uppercase tracking-wider mb-1">
            Notes
          </p>
          <p className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap">{c.notes}</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <Stat label="Opportunities" value={opportunities.length} />
        <Stat label="Won" value={opportunities.filter((o) => o.status === "won").length} color="emerald" />
        <Stat label="Lost" value={opportunities.filter((o) => o.status === "lost").length} color="red" />
        <Stat label="Won $" value={fmtDollars(wonValue)} color="emerald" />
      </div>

      {/* Opportunities */}
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">Opportunities</h3>
      {opportunities.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No opportunities linked yet. Link one from the opportunity detail page.
        </p>
      ) : (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700">
          {opportunities.map((o) => (
            <Link
              key={o.id}
              href={`/opportunity/${o.id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{o.title}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {o.agency && <span>{o.agency} · </span>}
                  {fmtDate(o.response_deadline)}
                  {o.estimated_value != null && <span> · {fmtDollars(o.estimated_value)}</span>}
                </p>
              </div>
              <StatusBadge status={o.status} />
            </Link>
          ))}
        </div>
      )}

      {/* Admin */}
      <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-700">
        <button
          onClick={handleDelete}
          className="text-xs text-red-600 dark:text-red-400 hover:underline"
        >
          Delete customer
        </button>
      </div>

      {editing && (
        <EditCustomerModal
          customer={c}
          onClose={() => setEditing(false)}
          onSave={async (patch) => {
            const ok = await save(patch);
            if (ok) {
              setEditing(false);
              showToast("Customer updated");
            }
          }}
        />
      )}

      {loggingContact && (
        <LogContactModal
          customer={c}
          onClose={() => setLoggingContact(false)}
          onSave={async (lineToAppend) => {
            const today = new Date().toISOString().split("T")[0];
            const newNotes = [lineToAppend, c.notes || ""].filter(Boolean).join("\n\n");
            const ok = await save({
              notes: newNotes,
              last_contact: today,
            });
            if (ok) {
              setLoggingContact(false);
              showToast("Contact logged");
            }
          }}
        />
      )}
    </div>
  );
}

function EditCustomerModal({
  customer,
  onClose,
  onSave,
}: {
  customer: Customer;
  onClose: () => void;
  onSave: (patch: Partial<Customer>) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    await onSave({
      name: String(form.get("name") || ""),
      company: (form.get("company") as string) || null,
      email: (form.get("email") as string) || null,
      phone: (form.get("phone") as string) || null,
      role: (form.get("role") as string) || null,
      notes: (form.get("notes") as string) || null,
    });
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Edit Customer</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Name *" name="name" required defaultValue={customer.name} />
          <Field label="Company" name="company" defaultValue={customer.company || ""} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email" name="email" type="email" defaultValue={customer.email || ""} />
            <Field label="Phone" name="phone" type="tel" defaultValue={customer.phone || ""} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Role</label>
            <select
              name="role"
              defaultValue={customer.role || ""}
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
              rows={4}
              defaultValue={customer.notes || ""}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LogContactModal({
  customer,
  onClose,
  onSave,
}: {
  customer: Customer;
  onClose: () => void;
  onSave: (line: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState<"email" | "call" | "meeting" | "other">("email");
  const [summary, setSummary] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!summary.trim()) return;
    setSaving(true);
    const today = new Date().toISOString().split("T")[0];
    const line = `${today} — ${kind}: ${summary.trim()}`;
    await onSave(line);
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Log contact with {customer.name}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Type</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
            >
              <option value="email">Email</option>
              <option value="call">Phone call</option>
              <option value="meeting">Meeting</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              What happened?
            </label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              placeholder="Sent intro email. No reply yet."
              required
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
            />
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Prepends a dated line to the Notes field and updates Last contact to today.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !summary.trim()}
              className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Log"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">{label}</label>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color?: string;
}) {
  const c =
    color === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : color === "red"
      ? "text-red-600 dark:text-red-400"
      : "text-slate-900 dark:text-white";
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">{label}</p>
      <p className={`text-xl font-bold ${c}`}>{value}</p>
    </div>
  );
}
