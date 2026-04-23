"use client";

import { useState } from "react";

export function RunQaButton({ awaitingCount }: { awaitingCount: number }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/qa/prepare", { method: "POST" });
      const body = await res.json();
      if (res.ok && body.ok) {
        setResult(body.message || "Notification sent.");
      } else {
        setError(body.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleClick}
          disabled={busy || awaitingCount === 0}
          className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-50"
          title="Emails Colin with the three commands to run locally. Claude Code needs OAuth + local PDFs, so the actual analysis happens on his machine, not here."
        >
          {busy ? "Notifying…" : "Run QA Now"}
        </button>
        <span className="text-xs text-indigo-700 dark:text-indigo-300">
          Emails Colin the command list. Claude Code still runs locally (can&apos;t run from the server without the owner&apos;s OAuth session).
        </span>
      </div>
      {result && (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">✓ {result}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300">✗ {error}</p>
      )}
    </div>
  );
}
