"use client";

import { useState } from "react";

export function RunTakeoffQaButton({
  oppId,
  hasTakeoff,
  hasQaReport,
}: {
  oppId: string;
  hasTakeoff: boolean;
  hasQaReport: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = !hasTakeoff || !hasQaReport;

  async function handleClick() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/qa/takeoff-prepare?opp=${oppId}`, { method: "POST" });
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
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || busy}
        title={
          !hasQaReport
            ? "Run QA analysis first — takeoff QA compares against identified_members"
            : !hasTakeoff
            ? "Upload a takeoff document (category: Takeoff) first"
            : "Emails Colin the three commands to run locally for takeoff QA"
        }
        className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium disabled:opacity-40"
      >
        {busy ? "Notifying…" : "Run Takeoff QA"}
      </button>
      {result && <span className="text-xs text-emerald-700 dark:text-emerald-300">✓ {result}</span>}
      {error && <span className="text-xs text-red-700 dark:text-red-300">✗ {error}</span>}
    </div>
  );
}
