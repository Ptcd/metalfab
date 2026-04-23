# TCB Metalworks — Bid Pipeline SOP (for VA)

**Owner:** VA
**Last Updated:** 2026-04-23
**Primary tool:** [quoteautomator.com](https://quoteautomator.com) (the Bid Pipeline OS)
**Access code:** `Steelbid123` (enter once, cached for a year)

---

## 0. What changed vs. the old SOP

The old SOP had you manually checking SAM.gov, SIGMA, Bonfire, eBuilder,
Daily Reporter, and filtering bid packages by hand every morning. Most of
that is **now automated** by the platform. You spend your time where the
machine can't go: **judgement, GC outreach, follow-up**.

You no longer need:
- The external pipeline tracker spreadsheet — the CRM is the source of truth.
- The separate GC tracker spreadsheet — use `/customers`.
- Manual portal checking — scrapers + email poller run daily at 6 AM CT.
- Division 05/10 filtering by hand — the AI reads the specs and marks each
  opp `qa_qualified` if there's real metals scope, `qa_rejected` if not.
- Building filtered PDF packages and emailing Colin — he reads them in the
  CRM, which has the summary and the documents already.

You still own:
- Reviewing the `qa_qualified` list each morning and flagging anything the
  AI got wrong.
- GC outreach emails (writing and sending them, and logging outcomes).
- Bid follow-up emails after deadlines.
- The re-bid workflow when TCB's GC loses.
- Telling Colin when something needs his eyes.

---

## 1. What TCB does (unchanged)

TCB Metalworks is a steel fabrication shop in Racine, WI. They bid as a
**subcontractor** to general contractors on commercial and public
construction projects.

**TCB does:** structural steel, misc metals, stairs, railings, ornamental
metal, fencing, canopies, specialty metal fab.
**TCB does not do:** glazing / curtain wall, roofing / metal panels,
HVAC / ductwork, full GC scope.

---

## 2. Your daily login routine

1. Go to [quoteautomator.com](https://quoteautomator.com).
2. Enter the access code `Steelbid123` once; the site will remember you.
3. Land on `/today`. This page is your morning dashboard.

The top strip shows 5 counters:

| Counter | Meaning | Action |
|---|---|---|
| **Qualified** | AI read the docs and said "bid this" | Review each one |
| **Awaiting QA** | Docs downloaded, waiting for the AI pass | Nothing — it runs automatically |
| **Reviewing** | Needs your eyes (no docs or borderline) | Read + decide |
| **Bidding** | TCB actively pursuing — follow-up needed | Track deadlines |
| **Won** | Awarded to TCB | Cheer |

Below that you'll see the actual opportunity cards, grouped by urgency.

---

## 3. Morning pass — 30 minutes

### Step 1. Review "Ready for Estimator" (green section)

These are `qa_qualified`. The AI already verified:
- Division 05 or 10 is in scope
- No deal-breakers (no AWS/AISC cert required, no PE stamp required)
- Dollar range is in TCB's lane
- Deadline is still in the future

For each card, check the **scope summary** and **risk flags**. Ask
yourself: "does this look right?"

- **Looks right** → no action. Colin gets it in his daily digest email.
- **Obviously not right** (e.g. the opp is a roofing job that hit on a
  "panel" keyword) → click in, change status to `passed`, add one-line
  note explaining why. The documents get purged automatically.
- **Unsure** → leave as `qa_qualified` and message Colin in the notes
  field with "Colin: ambiguous, please confirm."

### Step 2. Clear the `Reviewing` queue

These are opps the scrapers / email poller found but couldn't auto-QA
(usually because the bid package is behind a login we don't have, like
PIEE for federal USACE jobs, or because nothing was attached).

For each:
1. Click the opp. Read the description.
2. If the source URL has a full bid package, download it and upload the
   relevant PDFs using the **+ Upload** button on the opportunity detail
   page. Category = `Specification` or `Drawing` as appropriate.
3. Once docs are uploaded, set status to `awaiting_qa`. The AI will
   process it on the next run.
4. If you can't find docs, or the opp is clearly out of scope, set status
   to `passed`.

### Step 3. Check the `Awaiting QA` counter

If the number is >5 and it's after 2pm, tell Colin so he can run the
Claude Code analysis.

---

## 4. Adding opportunities manually

Things the scrapers don't catch: phone calls, jobsite tips, forwarded
emails (when the AOL poller doesn't classify them), referrals, industry
rumors.

### Quick-add (typed)
`/dashboard` → `+ Add Opportunity` → fill form. Required: title. Recommended:
GC/customer, deadline, description, confidence (hot/warm/cold).

### PDF drop (fastest)
On `/dashboard`, **drag a PDF onto the page**. A modal opens with the
title pre-filled from the filename. Fill in customer and deadline, check
"Queue for AI analysis", save. The AI reviews it within a day.

### Forwarded email
If someone forwards you a bid email, forward it to your AOL
(tcbmetalworks@aol.com). The morning sweep will classify it. If it's a
legitimate bid it'll show up in the CRM automatically.

---

## 5. Customers (the new GC tracker)

`/customers` replaces the spreadsheet. Every GC, architect, owner, and
referral source lives here.

### Logging a new GC
1. `/customers` → `+ New Customer`.
2. Required: name. Recommended: company, email, phone, role (GC /
   architect / owner / referral).
3. Save.

### Logging outreach
When you send an outreach email to a GC:
1. Open `/customers/<their profile>`.
2. Update the **Last contact** date.
3. Add a line to **Notes**: `2026-04-23 — sent intro email, no reply yet.`

Later, when they reply:
- Add another note line with the outcome.
- If they add TCB to their bid list, put "on bid list" in notes so we
  know for next time.

### Linking an opportunity to a customer
When you create or edit an opportunity, use the **Customer picker** in
the modal / detail page. That links the opp to the GC so you can see
"what opportunities has Kraemer Brothers sent us, and what's our hit
rate?" on the customer's profile.

### Outreach cadence (unchanged from old SOP)
- 5–10 new outreach emails/week.
- First follow-up at 7 days if no response.
- Second follow-up at 14 days.
- After 2 follow-ups, mark the customer profile with "no response, paused".

### Outreach email template (unchanged)

> **Subject:** Steel Fabrication Sub — TCB Metalworks, Racine WI
>
> Hi [Name],
>
> I'm reaching out from TCB Metalworks in Racine, WI. We're a structural
> steel fabrication shop and we'd like to get on your bid list for upcoming
> projects with Division 05 or Division 10 scope.
>
> We handle structural steel, miscellaneous metals, and specialty metal
> fabrication for commercial and public projects across Wisconsin.
>
> Would you be open to adding us to your subcontractor list? Happy to send
> over our qualifications or references.
>
> Thanks,
> [Your name]
> TCB Metalworks
> Racine, WI

---

## 6. Bid tracking & follow-up

When Colin tells you TCB submitted a bid, update the opportunity:
1. Open the opp detail page.
2. Change status to `bidding`.
3. Fill in **TCB Est. $** with TCB's bid amount if Colin shares it.
4. Add a note line: `2026-04-23 — bid submitted to Kraemer at $127k.`

### Follow-up cadence (unchanged)
- 3 business days after the overall project's bid deadline: email the GC
  asking for status. Log in opp notes.
- 10 days after: second follow-up. Log in opp notes.
- After 2 follow-ups with no response: status stays `bidding`, add note
  "awaiting award".

### When the GC wins but TCB isn't confirmed yet
Opp stays `bidding`. Note: "GC won, awaiting sub award." Follow up weekly
with the GC.

---

## 7. Re-bid workflow (this is the money maker)

When TCB's GC loses a bid, there's still a chance — the winning GC may
still be collecting subs. Same project, different GC.

1. Monitor award announcements. For federal, SAM.gov. For state/local,
   SIGMA / Bonfire / Daily Reporter / city websites.
2. When an award posts, check the opp in the CRM:
   - If TCB's GC won → status stays `bidding`, add note "GC won, awaiting
     sub award."
   - If TCB's GC lost → see below.

### When TCB's GC loses

1. Find the winning GC in the award announcement.
2. Check `/customers`:
   - Already in there → open their profile.
   - Not in there → `+ New Customer`, add them with role "GC".
3. Email the winning GC:

    > **Subject:** [Project Name] — Steel Fab Sub Available (TCB Metalworks)
    >
    > Hi [Name],
    >
    > Congratulations on the [Project Name] award. TCB Metalworks is a
    > steel fabrication shop in Racine — we'd love to bid the Division 05
    > scope on this project if you're still selecting subs. Happy to send
    > our bid over.
    >
    > Let me know.
    >
    > Thanks,
    > [Your name]
    > TCB Metalworks

4. In the original opp in the CRM, add a note: `2026-04-23 — re-bid
   outreach sent to ACME Construction (winning GC).`
5. If ACME responds positively, **create a new opportunity** for the
   re-bid (same project, different GC), link it to the ACME customer
   record, upload the bid package.

---

## 8. Status reference

| Status | Meaning | How it's set |
|---|---|---|
| `new` | Just arrived from scraper / email | Auto |
| `reviewing` | Needs human eyes (no docs or borderline) | Auto or you |
| `awaiting_qa` | Docs downloaded, queued for AI | Auto |
| `qa_qualified` | AI says "bid this" | Auto |
| `qa_rejected` | AI says "pass" (docs auto-purged) | Auto |
| `bidding` | TCB submitted a bid | You |
| `won` | TCB awarded the steel scope | You |
| `lost` | TCB did not get the work | You |
| `passed` | Human reviewed and intentionally skipped | You |

Never leave an opp in `qa_rejected` and pretend you'll revisit — if you
disagree with the AI, change it to `reviewing` or `qualified` yourself.

---

## 9. Daily report (end of day)

Copy this block into your daily report:

```
TCB Daily Report — [date]

QUEUE HEALTH:
- Qualified: [count from /today top bar]
- Awaiting QA: [count]
- Reviewing: [count]

NEW THIS MORNING:
- [Project name] — [source] — [bid deadline]
- [Project name] — [source] — [bid deadline]

REVIEWED QA-QUALIFIED:
- [Project name] — [kept / passed / flagged to Colin]

SENT TO ESTIMATOR:
  (Colin auto-receives the qa_qualified digest at 2pm CT; note only if
   you changed anything)

GC OUTREACH:
- [X] new emails sent, [X] follow-ups, [any positive responses noted]

AWARDS CHECKED:
- [Project name] — [GC won / lost] — [re-bid sent Y/N]

BLOCKED:
- [What's stuck and why — one line per blocker]
```

---

## 10. Weekly KPIs (unchanged targets)

| Metric | Target |
|---|---|
| New opportunities logged | 10+/week |
| QA-qualified opps reviewed | 100% same day |
| GC outreach emails | 5–10/week |
| Follow-ups on submitted bids | 100% at 3d and 10d marks |
| Re-bid emails sent when TCB's GC loses | Within 48 hours of award |

---

## 11. Rules

1. **Check the CRM every working day.** Bids expire. A missed deadline is
   a missed job.
2. **Trust the AI pre-filter.** When an opp is `qa_qualified`, assume
   Division 05/10 is really in scope. Only override when you have a
   specific reason.
3. **Never submit a bid yourself.** Colin and the estimator handle pricing
   and submission. You source, filter, track, and follow up.
4. **Log outreach the day it happens.** If you can't log it in `/customers`
   right then, log it within 24 hours. Untracked outreach is lost
   outreach.
5. **Re-bid when TCB's GC loses.** This is the single most valuable thing
   you do. Free pipeline, zero competition from the scraper.
6. **Batch Colin questions.** One message per day unless urgent. "Urgent"
   = deadline <24h, or the AI did something clearly wrong on a $500k+
   opp.
7. **Never delete customer records.** Even "no response" GCs might open a
   bid list next year. Mark paused, don't delete.

---

## 12. Troubleshooting

| Situation | What to do |
|---|---|
| Site won't load | Check quoteautomator.com status. If dead, email Colin. |
| Access code doesn't work | Clear cookies, try again. Still broken → email Colin. |
| A file won't upload | It's likely >100 MB. Zip it or split it. |
| Opp is missing an obvious doc | Check if it's an PIEE / auth-required portal. Add a note so Colin knows. |
| AI classified something wrong | Override the status yourself + add a one-line note. If it happens 3+ times in a week, tell Colin so the prompt can be tuned. |
| AOL inbox piling up with junk | The morning sweep trashes known spam. If real spam is still landing, tell Colin which senders so the pattern gets added. |

---

## Quick reference card

- Home: [quoteautomator.com/today](https://quoteautomator.com/today)
- Pipeline: [quoteautomator.com/dashboard](https://quoteautomator.com/dashboard)
- Customers: [quoteautomator.com/customers](https://quoteautomator.com/customers)
- Activity / system runs: [quoteautomator.com/activity](https://quoteautomator.com/activity)
- Config (read-only for VA): [quoteautomator.com/config](https://quoteautomator.com/config)
- Access code: `Steelbid123`
