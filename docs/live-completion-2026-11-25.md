# Walshken production completion — 25 November 2026

## Scope and release decision

The owner authorized completing the remaining work and releasing it on the existing Vercel project without another permission request. This release carries the reviewed staff, jurisdiction, payroll, permissions, audit and privacy work from `codex/walshken-role-qa` into the existing production application. The starting production commit was `2e6480cb78fac8e9bc8799fbd64b996e3e240fda`; the latest reviewed feature baseline was `7475f55bd4448f00ec24c7eb2ebb8fa196bbe198`.

Live portal: https://www.walshken.com/staff. The existing design, production database, private object storage, calling service, users and authenticator factors are retained. Live malware scanning remains explicitly deferred by the owner. Document validation, private storage, authenticated previews, sharing, downloads and access revocation continue to operate.

Software workflow completion does not verify the company's registrations or employee declarations. Real payroll requires independently reviewed employer, employee, policy and opening-balance inputs. Unsupported or unverified statutory cases stop with a configuration explanation; future-year rules are never silently copied from the previous year.

## Defects corrected in this release

| Finding | Result |
| --- | --- |
| Scoped Admin could change company-wide communication retention and erase other departments' messages | Global policy and purge require Super Admin. Scoped group moderation remains available. Cross-department denial is regression-tested. |
| Storage credentials could not rotate while documents or recordings existed | Replacement credentials are verified against the same endpoint, region and bucket; shared document/recording accounts check both buckets. Relocation and rotation during an active recording remain guarded. Failed verification preserves the previous configuration. |
| Payroll projected an extra weekly/biweekly payment beyond the fiscal year | Remaining payments now count only scheduled payment dates within that fiscal year. Canadian, Indian and Pakistani year-boundary regressions were added. |
| Production provider checks depended on preview-only credentials | The build preflight resolves the same encrypted saved provider settings and document bucket as the running application. It checks LiveKit authentication and private S3 access without exposing credentials. |
| Tests could race across authenticator time windows | Enrollment and rotation test clocks are deterministic; real signatures, replay protection and session checks are retained. |
| No enforceable full regression gate before production builds | GitHub CI and Vercel production prebuild run isolated regression suites. Subprocesses receive no live database, provider or deployment secrets. A failing or timed-out suite blocks the build. |
| Public canonical still used the Vercel test hostname | The canonical origin is `https://www.walshken.com`. Indexing is explicitly production-only; private pages and unpublished markets remain excluded. |
| Immutable source records could not be locked by the restricted production database role | The production rollout adds only the narrow row-lock privileges required, with restrictive policies preventing ordinary updates. Unapproved deletion stays blocked; exact approved-manifest deletion is tested under the real nonowner role. |
| General workflow email had no delivery queue or retry handling | A durable, opt-in queue now captures new notifications, supports bounded retries and idempotency, and shows each user's own delivery state. Sender activation remains a separate operational dependency. |

## Module status

Status applies to the described scope. Automated route tests use disposable databases. Provider transport is simulated in local route suites; a live build preflight separately checks actual calling/storage authentication. Those checks do not establish two-device media quality or inbox delivery.

| Module | Status | Delivered scope and practical limit |
| --- | --- | --- |
| Staff access and MFA | COMPLETE AND TESTED | Six roles, password hashing, enrollment/recovery, replay rejection, suspension, expiry, scoped records and existing factor preservation. |
| Employee and organization management | COMPLETE AND TESTED | Employee profiles, organizational units, reporting relationships, status, effective employment records and configurable action authority. Actual company records require accurate onboarding. |
| Employment geography | COMPLETE AND TESTED | Three employment countries and 59 jurisdiction entries; editable country/subdivision metadata and employment assignments. Public website country availability remains worldwide. |
| Effective policy engine | COMPLETE AND TESTED | Typed work, overtime, holiday-calendar, leave, payroll and pay-standard versions; official-source references, independent verification, future dates, conflict/supersession checks and historical snapshots. Specialist legal methods beyond supported settings are not inferred. |
| Statutory policy coverage | PENDING LEGAL VERIFICATION | Geography and implemented calculation methods do not establish every employer/occupation's applicable law. Missing or unverified employment coverage blocks the relevant workflow. |
| Attendance, shifts and timesheets | COMPLETE AND TESTED | Explicit attendance clocks, paid/unpaid breaks, overlap rejection, overnight work, corrections, recurring shifts, swaps, approvals, absence records, scoped reports and payroll source tracking. Login/logout never creates attendance. |
| Leave and holiday workflows | IMPLEMENTED BUT NOT FULLY TESTED | Requests, approvals, balances, accrual, independent adjustments/carry, calendars, standard Alberta entitlement and configured country-specific methods are tested. Actual employer-specific leave and holiday packages still require review. |
| Unified calendar | COMPLETE AND TESTED | Real shifts, leave, holidays, meetings, task dates and payroll events; employee/manager/admin scope, country/jurisdiction filters, overnight handling and duplication controls. Full device/accessibility acceptance remains separate. |
| Payroll lifecycle | COMPLETE AND TESTED | Effective rates, approved work, earnings/deductions, openings, calculations, separate review/finalization, immutable history, PDF payslips, exports, corrections and recorded payment reversals. Bank transfers and statutory remittances are not performed by this workflow. |
| Country payroll methods | IMPLEMENTED BUT NOT FULLY TESTED | Canadian regional packages, Indian new/old tax and contributions, Pakistani salary withholding and contributions; period-specific elections and employer levy assessments. Synthetic end-to-end examples are not certification of real company payroll. |
| Alberta reporting pay | COMPLETE AND TESTED | The standard eligible one-hour shift at CAD25/hour receives a CAD20 supplement to reach CAD45. Actual recorded hours remain one hour. Exempt or specialist categories require the applicable reviewed treatment. |
| Future tax years | IMPLEMENTED BUT NOT FULLY TESTED | Effective-dated rule versions and historical snapshots are supported. Unverified future rates are not published as law. |
| Payroll provider settings | IMPLEMENTED BUT NOT FULLY TESTED | Visible provider setup, encrypted credentials, connection tests and reviewed signed-calculator contract. No external statutory payroll calculator has been connected or certified for this employer. |
| Granular personnel/payroll authority | COMPLETE AND TESTED | Role or employee grants/denials across organization, country, division, department, office and employee scope. Sensitive operations validate authority on the server; independent review rules remain enforced. |
| Audit and management oversight | COMPLETE AND TESTED | Combined audit streams, search/date/category/person filters, scoped CSV, security failure signals and management totals. Historical before/after fields absent from older records cannot be reconstructed. |
| Privacy exports and archives | COMPLETE AND TESTED | Own/scoped access, independent approval, private storage, authenticated downloads, archive/restore, immutable events and cleanup retries. |
| Original-record disposal | COMPLETE AND TESTED | Frozen exact-hash manifests, separate review, confirmation phrase, fresh permission/retention/legal-hold checks, immutable receipts, source deletion/redaction and durable storage cleanup. Deployment itself disposes of no business record. External backups and previously downloaded copies have separate retention. |
| Private messaging and documents | COMPLETE AND TESTED | Scoped conversations/groups, messages/search/read state/reactions/mentions, chat document references, document versions/previews/downloads/sharing and current ACL revocation. |
| Calls and meetings | IMPLEMENTED BUT NOT FULLY TESTED | LiveKit authentication, scoped tokens, waiting room/media authority, consented recording, expiring download permissions and maintenance. A live two-device audio/video/recording acceptance session is still required. |
| Tasks and projects | COMPLETE AND TESTED | Assignments, deadlines, status/review/approval, comments, supporting files, timers/manual logs, overdue notifications and scoped reports. |
| In-app notifications | COMPLETE AND TESTED | Persistent recipient-specific workflow updates and read state. |
| Email notifications | BLOCKED BY EXTERNAL PROVIDER | Delivery queue, recipient opt-in, generic sign-in links, idempotency, retries, lease recovery and own delivery history are implemented and transport-tested. The prepared sender needs DNS verification, a protected sending key and an authorized delivery/receipt check. |
| Live malware screening | BLOCKED BY EXTERNAL PROVIDER | Deliberately deferred per the owner's instruction. Scanner integration/quarantine paths exist, but no live scanner is provisioned and uploads are not represented as malware-scanned. |
| Backup restore and capacity acceptance | IMPLEMENTED BUT NOT FULLY TESTED | Migration rollback probes and record fingerprints are verified. No provider restore drill, independent penetration test or 100/500-user load test has been executed. |

## Country and policy coverage

| Country | Geographic entries | Implemented payroll scope |
| --- | --- | --- |
| Canada | 10 provinces, 3 territories and a federal employment entry | Federal/provincial withholding packages for the 13 regions; CPP/QPP, EI/QPIP, dated tax parameters and applicable configured employer levies. Standard Alberta wage/overtime/holiday/reporting-pay workflows have specific regressions. Federal employment classification and tax province are distinct inputs. |
| India | 28 states, 8 union territories and a central entry | New/old regime salary TDS, statutory contribution packages, EPF/EPS allocation, ESI, reviewed professional-tax inputs, PAN treatment and employer/worksite applicability. |
| Pakistan | Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan, Azad Jammu and Kashmir, and a federal entry | Salary withholding, EOBI, reviewed provincial/social-security/other levy assessment and employer/employee applicability. |

A Super Admin can maintain the supported geography, employment circumstances, work/break/overtime/calendar/leave/pay-standard rules, annual tax parameters, employer registrations and scheme coverage, contribution assessments, permissions, retention and legal holds through the dashboard. Each verified rule has its own source, effective period and review evidence. Ordinary supported policy changes do not require code deployment. A new legal calculation method outside the implemented model still requires a validated adapter or implementation.

The payroll package checks were compared with official Alberta employment standards, CRA T4127 2026 publications, Revenu Québec's 2026 formulas, India's official Budget/EPFO sources and Pakistan FBR's Finance Act 2026 circular. This does not replace independently checking applicability to the actual employer and employee.

## Database and release controls

The four reviewed feature migrations add 37 tables and two leave-request columns. Production runtime grants explicitly close the Supabase anonymous/authenticated Data API, maintain organization and production-stage scope, and preserve QA separation. The notification outbox adds two further tables and a trigger; its migration and privileges are applied together so existing notification inserts continue to work.

The original six public history/payroll guard definitions and critical record fingerprints were captured before the rollout. Existing personnel, credentials, authenticator factors, encrypted integration settings and document versions are compared after the additive migration. This is a configuration/integrity snapshot, not a full data backup. The connected Supabase metadata did not expose a verified restore point; no backup restore is claimed.

The production build uses the existing production database and encryption keys. Preview connection strings, accounts and provider defaults are not copied into production. The checked-in operational rollout and rollback reference are retained under `ops/production/`. Reverting the deployment retains additive data; it must not reset authenticator factors or run destructive down migrations.

Production defaults include the approved staff workflow flags, private storage, required staff MFA, malware-screening deferral, the canonical custom domain and public indexing of published content. Email preferences remain off by default even when the notification module is available.

## Verification evidence

The initial integrated release candidate passed TypeScript, all 12 existing aggregate suites and the optimized Next.js build under Node22. Those suites cover public SEO, staff, messaging, calls, documents, tasks, workforce, payroll, holidays/calendar, employment policies, country payroll and complete privacy/employer workflows. The email extension adds its own isolated regression suite. Final Vercel production prebuild runs the complete gate again on the released source.

Additional database probes use the real nonowner runtime role, verify organization/stage isolation, row-lock access, history immutability, rejection of raw deletes/updates and the exact approved-manifest exception. Synthetic rows are inside rollback transactions. Live provider preflight verifies authentication and writes/deletes disposable verification objects; it does not send an email or place a call.

The final deployment ID, exact commit, production domain checks and observed provider results are recorded in the delivery message and Vercel build logs. Test success must be distinguished from real employer/legal onboarding and human media acceptance.

## Remaining operational inputs and cost

1. Supply the actual legal employing entities/registrations, worksites, classifications, scheme coverage/exemptions and independently reviewed jurisdiction policies.
2. Record accurate employee declarations, compensation and opening balances; have a different authorized reviewer approve the required inputs before the first real payroll.
3. Complete the dedicated notification sender's DNS verification and protected sending-key configuration, then an authorized email receipt check. Exact records are in [notification-email-setup.md](notification-email-setup.md).
4. Keep live malware scanning deferred until a persistent scanner/gateway is provisioned and tested, as previously directed.
5. Complete two-device media/recording acceptance, a restore drill and representative capacity testing before making claims about those outcomes.

No new paid subscription, server or hosting project is purchased for this release. Account inspection reports the existing Vercel team on Pro and the Supabase organization on Free. Vercel billing data is shared across other projects, so it cannot establish a Walshken-only monthly total. Existing hosting, calling, storage and email usage remain subject to their provider limits and billing. The connected email account currently permits 100 messages/day and 3,000/month across its projects; the sender domain was created within its existing allowance. No automatic plan upgrade was made.
