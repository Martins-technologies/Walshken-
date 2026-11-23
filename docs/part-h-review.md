# Part H — Canadian holidays and employment compliance

Extend the Part G review branch in Martins-technologies/Walshken-. Publish only to Preview in the existing walshken Vercel project and Supabase ssggjxyexwkshtcypsaq. Keep main, Production variables/deployment and existing authentication unchanged. No synthetic employee, work, wage, eligibility or payment records are deployed.

## Implementation contract

- Separate country, province/territory, employment jurisdiction, employee location and applicable calendar. Federal employment jurisdiction is distinct from provincial location; never apply federal holidays to every Canadian employee automatically.
- Versioned Canadian federal/provincial/territorial calendars with statutory, optional and special-law observances, verified official sources and effective dates. The initial full employment-calculation package is Alberta standard adult employees. Additional jurisdictions require their own verified calculation package; an unsupported calculation must not produce zero entitlement.
- Statutory holidays are generated from the assigned legal calendar and cannot be disabled. Optional recognition, paid company holidays, location/group targeting and closures are separate records. Recognized Alberta optional general holidays use the same statutory entitlement rules. A closure is not authority to remove statutory pay.
- Eligibility is computed from approved actual work history and independently approved dated imported records/coverage. Hire dates remain distinct from account dates. Missing evidence is shown as unresolved, not ineligible. An administrator cannot replace a computed entitlement with an arbitrary zero or a lower amount.
- Lawful exceptions have specific grounds, official authority, evidence and independent review. Keep consented absence distinct from an unauthorized absence. Record actual work on the holiday and calculate ordinary wages, premium pay and days off in lieu under the applicable version.
- Support corrected assessments and auditable post-finalization adjustments. Preserve finalized payroll and original legal-rule snapshots. Check input freshness when approving and finalizing.
- Connect company closures and holiday dates to actual staff schedules, payroll and employee holiday views. Managers see only their scope; compensation information requires payroll authority or ownership. Audit assignment, optional-observance, history, exception and eligibility changes.
- Bind Alberta overtime, meal/rest, vacation, record-retention and schedule minimums to versioned rule data. Employer benefits may exceed mandatory floors. Do not use one jurisdiction's laws as a platform-wide fallback.

## Verification

Use isolated route/database tests for calendar dates and observance classification, mandatory-pay protection, history completeness, lawful-exception review, company/group targets, closure/schedule integration, worked/unworked regular/non-regular holidays, both Alberta wage windows, lieu/vacation handling, rule-version snapshots, stale assessments, privacy, RLS and payroll finalization. Run the earlier staff, messaging, calls, documents, tasks, attendance and payroll suites plus TypeScript and the optimized Next.js build. No live fixture accounts, MFA resets, synthetic payroll or invented balances.

## Delivered scope and activation

The preview retains Parts E–G and adds `/staff/holidays` for administrators/HR and `/staff/holiday-calendar` for employees. No external API is required for Part H. The deployment uses the existing Walshken Supabase database and the existing walshken Vercel project, with branch-scoped flags and Preview-only grants.

The maintained calendar package covers 2026–2028, with one federal and thirteen provincial/territorial calendars. Initial automatic holiday/employment calculations cover Alberta standard adult employees in CAD; Canadian tax deductions retain Part G's separately versioned Alberta 2026 engine. Calendar availability does not imply another province's deductions or employment engine is implemented. Occupational exemptions, youth employment, construction/farm rules, averaging/overtime-banking agreements and additional country/province calculation packages require separate verified implementations. Unsupported engines fail explicitly; they do not substitute Alberta rules or produce a misleading zero.

Before calculating real entitlements, authorized users must record the actual employment jurisdiction/hire date, calendar/location assignment, normal workdays, effective compensation/payroll policy, encrypted date of birth/home address and independently verified historical coverage. There are no invented workdays, rates, account dates used as hire dates, balances or consent records. Salary ADW uses verified actual daily ordinary salary wages. Imports accept actual daily CSV records or a header-only coverage declaration where complete portal records already exist.

Company holidays and closures are targeted to actual employees or resolved department/division/office/messaging-group members with the membership snapshot recorded. Future events may be amended/cancelled with audit history; past/finalized benefits cannot be silently removed. Company closures and approved paid substitute days create protected scheduling records. Old time-off controls cannot remove those rights. Actual no-shows require evidence, independent review and a lawful ground; employer-consented absences can be restored with an independently approved withdrawal.

Paid-day arrangements require the employee's own authenticated consent, a distinct normal paid day and a verified deadline. Actual holiday work, statutory holiday pay and post-termination untaken-day settlements have separate allocation components. Finalization prevents double allocation. Corrections and retroactively recognized benefits credit actual immutable earlier earnings and require an exact authorized underpayment adjustment; they do not edit historical net pay or automatically recover overpayments.

## Verified before publication

- `npm run test:holidays`: isolated routes/database covering fourteen calendars, movable dates, access scope, unresolved history, thirty actual workdays, both ADW windows, hourly worked/unworked and non-regular holidays, consent, vacation deferral, employer-termination settlements, no-show/excused-absence changes, protected schedules, immutable legal/payroll snapshots, encrypted records, private PDF/CSV, positive correction enforcement, retroactive benefits and stronger effective rule versions.
- Earlier staff, messaging, calls, documents, tasks, workforce and payroll regression suites pass. TypeScript and the optimized Next.js build pass. Actual route output renders through the holiday React interface. Browser/device visual acceptance and the owner's end-to-end Preview review remain to be completed; these checks are not a blanket certification of every prior B–G feature.
- Hosted migration creates twelve RLS-protected tables and fourteen legal calendar packages. Preview runtime can access Preview records; Production, anon and authenticated roles receive no access to the new tables. No live employee/work/payroll fixtures, calendar assignments, private records, consents or assessments are seeded. Security advisors show no new finding; five prior default-deny legacy tables remain unchanged.

Production main and its Vercel deployment/variables remain unchanged. This is a review deployment only, not a merge or production release.
