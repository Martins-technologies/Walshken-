# Staff portal review status

25 November 2026, Asia/Karachi

## Release assessment

The full enterprise prompt remains **PARTIALLY IMPLEMENTED**. The review update adds working policy management, effective employment routing, leave accounting, security controls and tests. It does not establish country-wide statutory compliance. Company migration into the full three-country payroll service is not approved by this report.

Production baseline is `2e6480cb78fac8e9bc8799fbd64b996e3e240fda`. Changes are prepared for the existing Walshken Vercel project on its isolated review branch. Production schema and deployment changes require separate authorization and verified backup/restore availability.

## Module results

| Module | Status | Executed scope and remaining requirements |
| --- | --- | --- |
| Staff authentication, MFA, sessions and existing profiles | COMPLETE AND TESTED | Existing local route suite passed all six roles, suspension, recovery and expiration. Optional SSO and hosted role-by-role acceptance remain separate scope. |
| Effective employment assignments | COMPLETE AND TESTED | Local tests cover country/workplace/classification records, future start dates, immutable history and matching jurisdiction validation. Imported employee data still requires company verification. |
| Country/subdivision registry | COMPLETE AND TESTED | Three employment countries and 59 jurisdiction entries, including federal/central entries. Additional subdivisions can be added and existing ones edited or disabled for new assignments. |
| Legal rule coverage across all three countries | PENDING LEGAL VERIFICATION | Geography is populated. Verified legal packages for every province/state, establishment and employee category are not populated. |
| Central policy engine | PARTIALLY IMPLEMENTED | Work, overtime, dated holiday calendars, leave and Canadian Alberta tax parameters have typed settings and effective versions. Broader holiday-pay methods, minimum-wage categories, statutory deduction methods and specialist arrangements still need supported implementations. |
| Attendance, shifts, breaks and timesheets | PARTIALLY IMPLEMENTED | Existing Alberta working-time suite passed. Work policy routing accepts independently verified configurations for other assignments. It does not establish all local statutory exceptions or specialist schedules. |
| Leave balances and adjustments | PARTIALLY IMPLEMENTED | Annual/monthly accrual, explicit proration, weekday/holiday exclusions, pending reservations, approval, cancellation, independent imported/carry/correction entries and snapshots are tested with synthetic rules. Statutory leave-category coverage and specialised accrual/carry rules remain pending. |
| Holidays and entitlement calculation | PARTIALLY IMPLEMENTED | Fourteen existing Canadian calendars and standard Alberta calculations are tested. Dated policy calendar entries route through the new resolver. Other holiday-pay eligibility and compensation methods require verified implementations. |
| Unified calendar | PARTIALLY IMPLEMENTED | Existing calendar suite passed. Regional policy dates, employee assignments and country/province/jurisdiction filters are added. Browser/mobile and full cross-assignment-range acceptance remain open. |
| Alberta reporting pay | COMPLETE AND TESTED | Earlier review regression passes. One required hour at $25 receives a $20 supplement, with actual recorded hours unchanged. Supported standard employee scope excludes specialist/occupational variations. |
| Native Alberta 2026 payroll | COMPLETE AND TESTED | Maintained regular remuneration, contribution, overtime, vacation, effective rate, approval, immutable statement and adjustment tests passed. Actual employer inputs and payroll reconciliation are still required for live operations. |
| Future Alberta tax parameter versions | IMPLEMENTED BUT NOT FULLY TESTED | The engine can load independently reviewed annual parameters and snapshot them. Tests prove future-year mechanics with explicitly synthetic parameters. A verified 2027 package and official-value reconciliation are still pending. |
| Other Canadian payroll jurisdictions | NOT IMPLEMENTED | Complete province/federal and Quebec calculation methods, including QPP/QPIP and transfer cases, still require implementation or an accepted compatible provider. |
| India payroll | NOT IMPLEMENTED | Complete TDS, EPF, ESI, professional tax, state wage categories and applicable employer deductions are not supplied by the metadata registry or generic work policy. |
| Pakistan payroll | NOT IMPLEMENTED | Complete income tax withholding, EOBI, provincial social-security and applicable local statutory methods remain open. |
| Payroll provider setup | PARTIALLY IMPLEMENTED | Identifier/display defects are corrected and saved-connection testing is added. No compatible statutory payroll provider is connected. Arbitrary vendor API keys do not satisfy the current signed calculator protocol. |
| Granular authority | PARTIALLY IMPLEMENTED | Existing personnel read/edit/status and payroll read/prepare/approve/finalize/payment rights support organization, country, division, department, office and employee scopes. The full expanded action-by-action matrix in the new prompt remains open. |
| Audit management | PARTIALLY IMPLEMENTED | Combined event stores, dates, categories, employee/administrator/current-country/current-department filters, details and CSV export are implemented. Complete historic organization-assignment and before/after capture for every older event are not reconstructed. |
| Privacy and retention | PARTIALLY IMPLEMENTED | Version proposals, legal minimum validation, independent approval and legal holds persist. Document deletion and message purge respect implemented guards. Full archival, privacy export requests and approved disposal workflows across every record type remain open. |
| Malware scanning | BLOCKED BY EXTERNAL PROVIDER | Quarantine states, private storage, failure handling, alerts and immutable scan events are implemented and transport-tested. The ClamAV gateway worker requires provisioning and a live clean/EICAR/stale-signature acceptance test. |
| Documents, private messages, tasks and calls | IMPLEMENTED BUT NOT FULLY TESTED | Existing regression suites passed. Live multi-device media/recording, scanner-connected uploads and hosted role acceptance remain pending. |
| Email notifications | PARTIALLY IMPLEMENTED | Protected access-code delivery through Resend exists. Complete notification delivery/retry/preference handling for every requested workflow remains open, with verified sender configuration also required. |
| Reports and analytics | PARTIALLY IMPLEMENTED | Existing attendance, task, payroll and calendar data plus overview and audit export are present. The full expanded cross-module report inventory still needs acceptance and completion. |
| Backup, recovery and capacity | IMPLEMENTED BUT NOT FULLY TESTED | Private schemas and scoped roles are verified. No provider backup restore drill, independent penetration test or real 100/500-user concurrency acceptance was executed. |

## Geographic coverage

- Canada contains ten provinces, three territories and a separate federal-jurisdiction entry.
- India contains 28 states, eight union territories and a central-jurisdiction entry.
- Pakistan contains Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan, Azad Jammu and Kashmir, and a federal-jurisdiction entry.

Internal subdivision identifiers are application identifiers. The registry describes geography and jurisdiction selection. Numeric legal rates are not inferred from these rows. Exact employer, establishment, employee-category and workplace applicability must be recorded and verified.

The public corporate website retains its worldwide market catalog.

## Policy and calculation controls

Super Admin can maintain employment country/subdivision metadata, schedule employment assignments, draft typed policies, copy settings into a replacement version, compare previous/current settings, cite sources, submit changes for independent verification, record leave adjustments and propose retention versions. Verified statutory policy versions require supersession. Their history cannot be silently edited or erased.

The resolver rejects unverified, missing, expired and conflicting policy coverage. Applicable work rules feed shift/break checks. Verified overtime settings automatically constrain the payroll profile while preserving stronger company thresholds/multipliers. Policy/calendar dates and employment assignments feed calendar views. Payroll validates period boundaries and snapshots its applied policy references. A policy or assignment change inside the period requires an aligned period. Automatic mixed-rule transition calculations remain open.

Work policies currently model the supported first/second break structure. Complex recurring-break, occupational, collective-agreement, banking and averaging arrangements require their own verified methods. The new registry does not make these arrangements automatically supported.

The Alberta native deduction engine accepts dated federal/provincial brackets, CPP rates/limits/exemption, EI rates/limits/employer ratio, basic credits and relevant thresholds. Its existing 2026 values retain their source. New values require a new independently reviewed version. Future-year test data is synthetic and is not a legislative rate package.

## Provider and integration status

Production database inspection confirms enabled `livekit` and `recording-storage` records. This update did not run a real call or recording. The isolated review schema has separate integration configuration.

Saved provider credentials can be tested from Super Admin Integrations without entering them again. LiveKit tests authenticate to its service. S3 tests check the private bucket, write a verification object, confirm public denial and delete that verification object. Payroll tests check its compatible endpoint. Test success/failure is recorded without credential values.

Saved Vercel encryption keys are sensitive values that the connector cannot retrieve. The original raw LiveKit and S3 credentials previously supplied by the owner have now been entered as protected settings scoped only to the isolated review branch. The runtime can use these server defaults without copying the inaccessible production encryption key. Saved dashboard settings take precedence, including an explicit disable. No secret is returned to the client. The calling page also uses the same resolver when deciding whether the provider is configured. The project and database remain the user's existing Walshken resources.

The review uses the separate private document and task buckets. Its recording history was checked to contain no production object references. The recording provider remains the existing private account. An opt-in deployment preflight authenticates LiveKit, checks private storage, writes a disposable verification object, checks public denial and deletes that object. Vercel build `dpl_79ntacCYbbCJJsR1Uow3TgEwDJ7R` passed all three protected provider preflights: LiveKit authentication, recording storage and document storage. The build and deployment are READY. This does not prove two-browser media, webhook delivery or successful recording. Local provider network calls did not complete successfully and are not counted as acceptance.

The LiveKit project must also deliver signed events to the review webhook for accurate meeting attendance and recording-start readiness. Its production webhook must remain in service. Review event delivery has not yet been verified.

ClamAV is supported through `ops/clamav-gateway.mjs`. A private worker, signature updates and HTTPS gateway are required. The worker has not been provisioned in this task. The gateway protocol and infrastructure requirements are in `ops/clamav-gateway.md`.

Email needs a verified sender/domain and a protected Resend configuration. Statutory payroll needs an accepted compatible service or completed native verified methods. Twilio remains deferred.

## Permission matrix currently available

| Actor | Default authority and configurable additions |
| --- | --- |
| Super Admin | Central policy, jurisdiction, retention, hold and permission management. Can appoint another enrolled Admin as Super Admin through step-up authentication. |
| Admin | Existing scoped personnel and management operations. Additional listed personnel/payroll actions can be granted. |
| HR/Payroll | Existing scoped payroll and workforce operations. Additional organization/country/office/action authority can be configured. |
| Manager | Existing team management. Additional listed personnel/payroll actions require grants. |
| Employee | Own permitted records and workflows. Listed delegated actions require explicit grants and scoped targets. |
| Guest | Existing restricted communication/document capabilities. No employment-policy administration. |

An explicit denial wins over an added grant for the same supported action. Super Admin authority has its separate privileged checks. The complete personnel and payroll permission list in the final prompt is not yet mapped to independent actions.

## Database impact and rollback

`20261124192707_staff_readiness.sql` remains the dependency for the previous governance work.

`20261124211828_dynamic_employment_engine.sql` adds eleven relations for country/subdivision metadata, effective employment terms, upload scan state/history, leave adjustments/reviews, retention versions/reviews and legal holds/releases. It extends the existing jurisdiction-version table with typed settings, hashes, category and supersession metadata. It adds leave-request entitlement snapshots and expands permission scope types.

New tables use RLS with public/anonymous/authenticated access revoked. Historical assignment, decision and event records have immutable guards. Explicit runtime grants were applied only to the isolated review schema. Production schema migration and production runtime grants remain unapproved and unapplied.

The review runtime was checked to have no SELECT privilege on public employees. The production runtime was checked to have no access to the review schema. Geographic rows and three unapproved Alberta reference policies were added only to the review schema.

Rollback uses the previous review commit. Additive review data remains for investigation. Production release still requires a verified backup/restore procedure, data-impact review, approved migration/grants and feature-flag activation.

## API changes

Existing authenticated `/api/workspace/governance/*` routes now accept employment-country-save, employment-region-save, employment-terms-save, employment-policy-save, employment-coverage, employment-leave-adjust, employment-leave-adjust-review, retention-save, retention-review, hold-create and hold-release. Existing jurisdiction-verify/withdraw actions enforce policy review and mandatory-version constraints.

`/api/workspace/integrations/test` tests saved settings. `/api/workspace/view/audit` accepts employee, administrator, country, department and `export=csv` filters. Existing attendance, schedule, leave, calendar and payroll entry points call the new resolver when enabled. Document/task/avatar uploads call the quarantine path when the employment-engine release flag is enabled.

## Executed tests

| Check | Result |
| --- | --- |
| TypeScript | PASS |
| Next.js optimized build | PASS |
| Staff route suite | PASS, including six roles and 100-record registry pagination |
| Message route suite | PASS |
| LiveKit route suite | PASS with provider transport substitutions |
| Document route suite | PASS with storage transport substitutions |
| Task route suite | PASS |
| Workforce route suite | PASS |
| Payroll route suite | PASS |
| Holiday/calendar suites | PASS |
| New employment suite | PASS with synthetic policy fixtures |
| ClamAV worker syntax | PASS |
| LiveKit authentication and private recording/document storage test transactions from Vercel | PASS in deployment preflight; real service requests, no provider substitutions |
| Real ClamAV scan | NOT EXECUTED |
| Hosted staff sign-in page and unauthenticated policy access | PASS: sign-in form rendered; governance endpoint returned 401 |
| Hosted acceptance across all roles, mobile/accessibility and two-browser calls | NOT EXECUTED |
| Provider backup restore, penetration test and concurrency load | NOT EXECUTED |

`npm run test:employment` exercises geographic counts, effective assignments, verification gates, self-approval rejection, conflict rejection, historical/future rules, jurisdiction calendar routing, leave reservations and carry adjustments, legal holds, retention floors, quarantine failure paths and future tax parameter mechanics. Synthetic values prove routing and arithmetic, not official legal coverage. The native payroll suite includes its existing authoritative CRA example regressions.

## Outstanding dependencies and implementation

1. Verify employing entities, actual employee work locations and covered establishment/employee categories. Geography alone cannot determine local tax, wage, social-security and employment-law applicability.
2. Complete and independently verify the missing country/regional payroll, holiday-pay and specialist employment methods. India and Pakistan statutory deductions are still implementation work. A compatible provider is an alternative once its coverage and contract are accepted.
3. Verify the new protected review provider configuration and signed webhook delivery, provision the scanner worker and configure verified email delivery.
4. Complete the expanded action permission matrix, all-record archival/export/disposal workflows, notification delivery workflows and remaining report acceptance.
5. Execute hosted role/media/security/accessibility, provider, reconciliation, restore and load tests.

Full production readiness cannot be asserted until these items are resolved.

## Files modified or added in this update

- `components/walshken/employment-management.tsx`
- `components/walshken/payroll.tsx`
- `components/walshken/retention-management.tsx`
- `components/walshken/staff-calendar.tsx`
- `components/walshken/staff-governance.tsx`
- `components/walshken/ui.tsx`
- `components/walshken/workforce.tsx`
- `components/walshken/workspace-admin.tsx`
- `components/walshken/workspace-views.tsx`
- `docs/staff-completion-plan.md`
- `docs/staff-completion-status.md`
- `lib/walshken/admin.ts`
- `lib/walshken/attendance-rules.ts`
- `lib/walshken/documents.ts`
- `lib/walshken/employment-admin.ts`
- `lib/walshken/employment-catalog.ts`
- `lib/walshken/employment-engine.ts`
- `lib/walshken/employment-settings.ts`
- `lib/walshken/holiday-engine.ts`
- `lib/walshken/jurisdiction-readiness.ts`
- `lib/walshken/leave-balances.ts`
- `lib/walshken/integration-settings.ts`
- `lib/walshken/livekit.ts`
- `lib/walshken/document-storage.ts`
- `lib/walshken/meetings.ts`
- `lib/walshken/payroll-calculator.ts`
- `lib/walshken/payroll-engine.ts`
- `lib/walshken/payroll-tax-ca.ts`
- `lib/walshken/retention.ts`
- `lib/walshken/scheduling.ts`
- `lib/walshken/server.ts`
- `lib/walshken/staff-calendar-types.ts`
- `lib/walshken/staff-calendar.ts`
- `lib/walshken/staff-delivery.ts`
- `lib/walshken/staff-governance.ts`
- `lib/walshken/staff-oversight.ts`
- `lib/walshken/staff-permissions.ts`
- `lib/walshken/staff-profile.ts`
- `lib/walshken/task-files.ts`
- `lib/walshken/upload-quarantine.ts`
- `lib/walshken/views.ts`
- `lib/walshken/workforce-data.ts`
- `lib/walshken/workforce.ts`
- `ops/clamav-gateway.md`
- `ops/clamav-gateway.mjs`
- `package.json`
- `supabase/migrations/20261124211828_dynamic_employment_engine.sql`
- `tests/verify-employment.mjs`
- `tests/verify-holidays.mjs`
- `tests/verify-livekit.mjs`
- `scripts/verify-deployment-providers.mjs`
- `.env.example`
