"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  toEmail?: string | null;
  customerId?: string | null;
  opportunityId?: string | null;
  buttonLabel?: string;
  /** Preset templates for common outreach flows */
  templates?: Array<{
    key: string;
    label: string;
    subject: string;
    body: string;
  }>;
}

const DEFAULT_TEMPLATES = [
  {
    key: "intro",
    label: "GC intro",
    subject: "Steel Fabrication Sub — TCB Metalworks, Racine WI",
    body: `Hi {{name}},

I'm reaching out from TCB Metalworks in Racine, WI. We're a structural steel fabrication shop and we'd like to get on your bid list for upcoming projects with Division 05 or Division 10 scope.

We handle structural steel, miscellaneous metals, and specialty metal fabrication for commercial and public projects across Wisconsin.

Would you be open to adding us to your subcontractor list? Happy to send over our qualifications or references.

Thanks,
TCB Metalworks
Racine, WI`,
  },
  {
    key: "followup_7d",
    label: "7-day follow-up",
    subject: "Following up — TCB Metalworks",
    body: `Hi {{name}},

Just following up on my email last week — would love to get TCB on your bid list for structural steel / misc metals scope. Let me know if you need any info from us.

Thanks,
TCB Metalworks`,
  },
  {
    key: "rebid",
    label: "Post-award re-bid",
    subject: "{{project}} — Steel Fab Sub Available (TCB Metalworks)",
    body: `Hi {{name}},

Congratulations on the {{project}} award. TCB Metalworks is a steel fabrication shop in Racine — we'd love to bid the Division 05 scope on this project if you're still selecting subs. Happy to send our bid over.

Let me know.

Thanks,
TCB Metalworks`,
  },
  {
    key: "bid_followup_3d",
    label: "3-day bid follow-up",
    subject: "Checking in on {{project}}",
    body: `Hi {{name}},

Just checking in on {{project}} — has a steel sub been selected yet? Let us know if you need anything else from us.

Thanks,
TCB Metalworks`,
  },
];

export function SendEmailButton({
  toEmail,
  customerId,
  opportunityId,
  buttonLabel = "Send email",
  templates = DEFAULT_TEMPLATES,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(toEmail || "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [tplKey, setTplKey] = useState("intro");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function applyTemplate(key: string) {
    const t = templates.find((x) => x.key === key);
    if (!t) return;
    setTplKey(t.key);
    setSubject(t.subject);
    setBody(t.body);
  }

  async function handleSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!to || !subject || !body) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        subject,
        body_text: body,
        customer_id: customerId,
        opportunity_id: opportunityId,
        template_key: tplKey,
      }),
    });
    const b = await res.json();
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      setSubject("");
      setBody("");
      router.refresh();
    } else {
      setErr(b.error || `HTTP ${res.status}`);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
      >
        ✉ {buttonLabel}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">Send email</h3>
              <button
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-xl"
              >
                &times;
              </button>
            </div>

            <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
              Sent via Brevo from <code>bids@quoteautomator.com</code>.
              {customerId && " Updates last_contact + logs a note on the customer."}
              {opportunityId && " Logs a pipeline event on the opportunity."}
              &nbsp;Replies auto-thread back here.
            </p>

            {err && (
              <div className="mb-3 p-3 rounded-md bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
                {err}
              </div>
            )}

            <form onSubmit={handleSend} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Template
                </label>
                <div className="flex flex-wrap gap-2">
                  {templates.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => applyTemplate(t.key)}
                      className={`px-2 py-1 rounded text-xs border ${
                        tplKey === t.key
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white dark:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Replace <code>{"{{name}}"}</code> / <code>{"{{project}}"}</code> placeholders before sending.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  To
                </label>
                <input
                  type="email"
                  required
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="mike@cdsmith.com"
                  className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Subject
                </label>
                <input
                  type="text"
                  required
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Body
                </label>
                <textarea
                  required
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={12}
                  className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-sm text-slate-900 dark:text-white font-mono"
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
                  disabled={busy || !to || !subject || !body}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? "Sending..." : "Send"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
