# Workforce controls review

24 November 2026. Preview candidate for Parts F–H. Production remains at its existing release until the owner approves a merge.

## Implemented in this change

- Separate action-level grants and denials for attendance management, policy editing, corrections, timesheets, schedules, leave, payroll preparation, approval, finalization, payments and holiday administration/evidence. Grants are reloaded on every authenticated request and retain assigned or organization scope.
- Protected promotion/demotion of another administrator, with password and fresh MFA/recovery verification, retained audit evidence and immediate session termination. The acting/last active Super Admin is protected.
- Effective attendance-policy history. Future policy versions preserve current settings and recorded attendance snapshots.
- Alberta minimum reporting-pay comparison for short required work, including separately treated split-work segments. Independently reviewed reporting classifications support documented personal departures, two-hour categories and verified variances. Already-finalized reporting classifications require a payroll adjustment rather than rewriting the original entitlement.
- Draft, submission, employee consent, separate review, cancellation and replacement workflows for banking/averaging agreements, vacation balances, reporting classifications and prospective sourced jurisdiction packages.
- Banked overtime credits created by finalized payroll, FIFO time-off reservations, statutory ordinary-hours checks, append-only leave debits, expiry/termination cash settlements and preserved earning-rate/currency evidence.
- Full-cycle Alberta averaging with written schedule and notice evidence, employee agreement, daily overtime and additional cycle-close premiums using effective earning rates. Shortened cycles are explicitly held for a separately verified settlement.
- Verified vacation-time opening balances, service-anniversary entitlement calculation from dated rules and work schedules, approved vacation usage excluding applicable holidays, overdraw prevention, cancellation restoration and overdue scheduling alerts without forfeiture. Vacation money remains in the payroll module.
- Prospective, sourced Canadian rule packages with validation and separate Super Admin approval. Mandatory calendar dates and maintained Alberta statutory floors remain protected. Native calendar horizons can be extended through reviewed packages.
- Correct Preview/Production payroll-integration identifiers, visible calculator configuration, verified provider coverage, encrypted credential storage and downloadable signed-calculator contract. A compatible signed holiday adapter supports separately verified methods; an API key alone does not establish compatibility.
- Operational Overview with personal/team scope, active clock state, actual time chart, approval queues, payroll setup readiness, pay deadlines, exceptions, published shifts and updates.
- Isolated Preview attendance maintenance and banked-leave calendar entries.

## Validation

Run `npm run test:workforce`, `npm run test:payroll`, `npm run test:holidays`, `npm run test:operations`, `npm run typecheck` and `npm run build`.

The operations suite exercises real authenticated application handlers and isolated PostgreSQL data. It includes immediate permission revocation, cross-role restrictions, immutable history, future policies, consent, separate approvals, vacation usage/reversal, reporting-floor payroll through finalization, expired-bank settlement and protected administrator appointment. Synthetic fixtures exist only inside the local test database, which is removed at exit.

## Preview setup

Use the existing `walshken` Vercel project and Supabase project `ssggjxyexwkshtcypsaq`. The role-review branch uses the isolated `walshken_role_qa` schema and its existing dedicated runtime credentials. The new workflow flag is scoped only to that Preview branch. No live employee, pay record, production environment setting, alias or production code is changed.

Use the existing isolated role-review logins. Production accounts belong to a separate identity schema. Real payroll operation additionally requires actual employer legal details, employee rates, dated policies, approved YTD balances, location/calendar assignments, employment evidence and vacation openings; the application does not invent these values.

## Explicit remaining coverage and acceptance limits

This is not a claim that every employment-law scenario or every jurisdiction is complete.

- The native deduction engine remains Alberta/CAD tax year 2026. Additional years, Québec deductions and wider jurisdictions require maintained native packages or a validated compatible provider, with provider acceptance tests before live use. No live third-party payroll calculator has been connected or reconciled in this change.
- The rule publisher initially supports the maintained Canadian calendar family. Other countries and occupational/collective-agreement/youth calculation methods need their own verified package and supported calculation method. Publishing a source URL does not create a new calculation engine.
- Mid-period payroll-policy/classification or legal-rule transitions remain blocked pending a supported transition calculation. Effective monetary rate changes already work within a period.
- Termination inside an averaging cycle is held for a separately verified shortened-cycle settlement. It is not silently processed as a complete cycle. Collective agreements with special averaging or banking treatment require a separate verified method.
- Protected-leave eligibility engines beyond the existing vacation/sick/personal/other recording and approval workflows are not supplied by this change.
- Recorded external payroll payments are an auditable ledger; bank transfers, remittances and government filings are not initiated automatically. Twilio delivery remains deferred as requested.
- Hosted manual acceptance for all roles, a real-payroll reconciliation and any configured external-provider acceptance remain necessary before a production release.

## Manual review sequence

1. Sign in with an isolated role-test account and review personal/team Overview scope.
2. In Work policies → Authority, test an explicit grant and denial. Reopen the affected account and verify the action changes immediately.
3. Schedule a future break policy and verify current attendance remains unchanged.
4. Create, edit, submit and cancel a draft. For banking/averaging, sign in as the employee to agree, then use a separate authorized reviewer.
5. Confirm a real vacation opening and use/reverse an approved vacation day. Verify hours and overdue scheduling status.
6. Calculate a short required-work payroll and review its reporting supplement and original worked hours. Use a separate reviewer and finalize.
7. Review sourced jurisdiction drafts with a different Super Admin. Use the protected appointment action if another trusted reviewer is needed.
8. Configure a compatible calculator only when its provider details are available; check jurisdiction/year coverage and signed results before relying on it.
