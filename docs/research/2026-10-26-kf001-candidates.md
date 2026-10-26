# KF-001 zero-cost discovery ledger — 2026-10-26

> Research-only draft. This branch is **not** production, does not trigger outreach, does not create a charge, and does not assert independent verification of claimant-provided documents. Public source assertions are marked CLAIM. No verified business contact = no outreach.

## Operating snapshot

- Discovery scope: public platform/cloud/API/AI/billing/payment/support disputes.
- Deduplication baseline: KF-034, KF-041 through KF-069, including previously duplicated KF-053/KF-068 and KF-055/KF-067. **No reuse of an existing candidate.**
- New research candidates: **KF-070, KF-071**. Both have **OUTREACH_READY=PENDING**.
- Watch/reject: KF-072 (risk concerns), unnamed Shopify 120-day release case (amount unverified), Younglabs (resolved), Shopify Plus $200k case (resolved), Oct 26 Railway/Gemini incident (amount and support record missing).
- Realized KF-001 revenue confirmed by this research: **$0**. Prospective revenue: **unquantified**, not booked. Costs/commitments: **$0**.
- No contact sent. No purchase, subscription, advertisement, fee, or paid escalation created.

## KF-070 — Shopify $116,826.91 payout lock after failed $704.84 deposit

- Source: https://community.shopify.com/t/urgent-116k-payout-blocked-ticket-70614400-system-error-loop-preventing-update/689614
- Case ID: KF-070 (provisional)
- Claimed exposure: USD **116,826.91** withheld; not confirmed as final loss.
- CASE_VALUE_SCORE: **90/100 provisional** (large cash exposure + precise support ticket + narrow technical bottleneck, reduced for missing business identity and independent documents).
- OUTREACH_READY: **PENDING** — public claimant account alone is not a verified company B2B channel.
- FACT: Public post dated Sep 29, 2026 identifies ticket **#70614400** and quotes the blocked bank verification message; Oct 22 reply seeks status, but is not a claimant resolution update.
- CLAIM: Merchant reports a $704.84 failed payout on Sep 25 led to $116,826.91 frozen; specialist Aman allegedly said the security verification requires manual Risk/Internal Underwriting clearance; no verification email/link received after checks.
- INFERENCE: A bank-verification UI loop may prevent completion of a risk review even when merchant wants to comply. This is a process-path contradiction, **not** evidence the hold is unlawful or the account is eligible for release.
- PLATFORM_STATEMENT: Shopify's official Payments account-holds help says only the store owner can resolve account-specific holds and that admin notifications/support are the designated route: https://help.shopify.com/en/manual/payments/shopify-payments/payouts/account-holds
- LEGAL_CONTEXT: Payment holds and verification reviews can be contractually/legally permitted. Applicable region, actual merchant account terms, payment processor and risk reason unknown.
- ESCALATION_PATH: Existing ticket #70614400 -> masked bank data currently on file -> failed payout record -> screenshot of UI error -> evidence of email delivery/address -> request a manual secure bank-verification path from Risk/Underwriting. Do not seek credentials or full bank numbers.
- Strongest evidence: precise amount, exact ticket, specific bank verification error and specialist handoff claim.
- Smallest plausible leverage: **“Which manual verification path can complete the bank-account check when the Shopify Finance interface rejects every attempted update?”**
- Evidence gate: original hold notice, ticket correspondence, bank-error screenshot, merchant authorization, company identity, outcome check.
- Contact: **none verified**. Do not infer company from claimant name or contact through guessed email.
- Draft outreach (HOLD): “I saw your public Shopify ticket #70614400. The specific issue appears to be a verification loop that prevents you from completing the bank check Shopify requires. If your ticket and screenshots confirm this, the narrow request is a documented manual verification path, not an unsupported demand for immediate release. I can help organize that evidence into one reviewable escalation.”

## KF-071 — $6,982.53 Gemini default-key abuse / Billing silence

- Source: https://discuss.ai.google.dev/t/6-982-53-unauthorized-gemini-api-charges-12-days-into-billing-finance-review-requesting-goodwill-review/166921
- Case ID: KF-071 (provisional)
- Claimed exposure: USD **6,982.53** outstanding disputed bill; original bank charges reportedly declined (not money already paid).
- CASE_VALUE_SCORE: **88/100 provisional** (detailed support chronology + narrow telemetry/auditability issue; missing case ID, identity, later outcome).
- OUTREACH_READY: **PENDING** — forum handle alone is not verified public business channel.
- FACT: May 27 public first-person forum report; follow-up May 29 says billing account suspended and no response on day 15. Google forum staff publicly responded with DM invitation, but no visible substantive billing decision.
- CLAIM: AI Studio auto-generated unrestricted key Aug 19, 2025, unused until May 13–14, 2026; unauthorized ~$6,982.53; contained within two hours; admin logs show no unauthorized console access; cards declined initial/retried collection; multiple Billing escalations and paid Cloud Support supervisor call failed to produce written timetable.
- INFERENCE: The dispute may be narrowed to whether Google Billing considered documented dormant-key creation defaults, the inability to audit `generativelanguage.googleapis.com` through native Cloud Audit Logs, and billing collection activity during a pending review.
- PLATFORM_STATEMENT: Forum staff offered a DM; no public waiver, denial, or policy decision is established. Google product documentation should be independently checked before relying on a platform logging-gap claim.
- LEGAL_CONTEXT: Technical default settings or logging gaps do not independently establish legal liability. Terms, credential handling and billing policy need original review.
- ESCALATION_PATH: exact Google case ID -> original key creation/configuration -> invoice/usage timeline -> containment proof -> declined collection notices -> supervisor/Finance correspondence -> one written determination with named owner and timeline.
- Strongest evidence: detailed incident dates, support chronology, collection retries and alleged paid escalation; documents are described, not independently inspected.
- Smallest plausible leverage: **“What written determination and decision deadline applies to the May 14 billing review, and is collection activity suspended while that review remains open?”**
- Evidence gate: exact case ID, itemized invoice, key history, support transcripts, current outcome, verified business identity.
- Contact: **none verified**. No private messages or guessed contacts.
- Draft outreach (HOLD): “I found your public $6,982.53 Gemini billing dispute. Your documented escalation chronology suggests the immediate issue is obtaining a written decision and a clear collection status while Billing reviews the evidence. If the original support and billing records confirm it, I can help reduce the case to one specific, answerable escalation.”

## Rejected or deferred leads

- **KF-072 / Wedrips** — claimed USD 31,749.80 Shopify payout hold, verification passed then failed. Source: https://community.shopify.com/t/payments-are-paused-and-held-even-after-verification-completion/687765 . **REJECT / score 42**: no clear exhausted Tier-1 support record; commenters cite significant storefront authenticity/brand concerns (unverified accusations, not adopted as facts); no verified business channel. Do not conflate payment hold with wrongful hold.
- **Shopify 120-day release hold** — https://www.reddit.com/r/shopify/comments/1x0yem7/shopify_promised_fund_release_after_sep_24_120day/ . **DEFER**: good pattern of promised release date versus disabled transfer control, but **no public amount**.
- **Shopify Plus ~$200k held** — https://community.shopify.com/t/shopify-plus-merchant-nearly-200-000-in-payouts-paused-for-12-days-with-no-merchant-trust-response/658644/1 . **CLOSED**: claimant explicitly reported full resolution the same day.
- **Younglabs ₹783,722.69 Gemini abuse** — https://discuss.ai.google.dev/t/unauthorized-gemini-api-charges-7-84-lakh-9-5k-usd-on-production-project-abuse-resumed-3-days-after-rotation-billing-extension-expires-tomorrow/144474 . **CLOSED**: claimant posted June 23 that Google fully resolved it.
- **Railway incident / Ada_Chou** — https://discuss.ai.google.dev/t/can-someone-help-me-open-a-billing-case-for-unauthorized-gemini-charges/195183 . **DEFER**: no amount, no billing case, and billing admin unavailable; support not yet exhausted.
- **SangHoon_Han tier lock** — https://discuss.ai.google.dev/t/project-special-tf-prod-stuck-at-tier-1-after-abuse-containment-remediation-completed-no-remaining-path-to-request-review/183414 . **DEFER/CLOSED?**: no quantifiable financial loss and Google staff indicated the 403 error was resolved Oct 22.

## Rules

- Distinguish public first-person claimant testimony from independently examined invoices/logs.
- Only a business's own official published channel or claimant's clearly established professional business channel can make OUTREACH_READY=YES.
- No unsolicited contact, no payment, no financial commitment, no fee, no paid service.
- No Owner Gate for routine zero-cost discovery. Owner Gate only if a next proposed action could impose a **specified** cost on Kesch; always show a zero-cost alternative.
- Do not treat claimed held funds as KF-001 revenue. Any success fee is speculative until agreed in writing and earned.
