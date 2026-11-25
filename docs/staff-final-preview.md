# Walshken staff acceptance preview

25 November 2026

The candidate is based on production commit `c2fd6247ab79765124c0fc4a0bc5ce159c5f1477`. Its scope is the existing Vercel `walshken` project's `codex/walshken-role-qa` branch and the isolated `walshken_role_qa` schema and runtime role in the existing Supabase project. Production release approval is separate.

## Connected employment workflows

This preview applies the employee's legally assessed assignment on the relevant date through the calendar, shifts, clock-in, breaks and payroll setup. Calendar country, region and jurisdiction filters evaluate event dates, including a transfer inside a single calendar view. Relevant company closures appear for employees on dated policies as well as on the original Canadian calendar. A shift spanning incompatible work policy versions must be split at the boundary. A published shift does not freeze the legal policy for a later clock-in. Work records preserve the rule applied when the employee actually clocked in. Payroll profile and rate changes use the jurisdiction, worker classification, currency and frequency of the applicable employment assignment.

The registry contains 14 Canadian, 37 Indian and 8 Pakistani jurisdiction entries. On November 25, 2026, the separate dated-policy tables had zero currently effective verified Work, Overtime, Holiday calendar, Leave or Pay standards category entries in either environment. The built-in Canadian calendars, standard Alberta policy and supported national/regional tax calculators are separate from this count. The dated rules must be populated and verified with official provisions and actual employer coverage before automated use. The detailed Canadian holiday eligibility and employer exception workflows remain narrower than the geography registry.

No new vendor API is involved in calendar, attendance, leave, scheduling or the supported internal payroll workflows. Bank disbursement and statutory submissions remain outside the recorded-payment workflow and need an appropriate regulated provider only if direct execution is required. Sender verification and malware scanner provisioning are separate operational dependencies.

Governance → Employment policies → Rule packs shows regional coverage for the selected classification and date. A Super Admin can import up to 60 policy versions in a transaction or generate a dated Canadian statutory calendar draft from the published dates. The import saves the versions and evidence in Supabase and preserves independent review before they take effect. An applicable reviewed package is used by the existing scheduling, attendance, leave and payroll workflows. The engine can represent daily-only or weekly-only overtime thresholds and laws requiring recurring uninterrupted rest. These methods still require the appropriate approved rate, qualifying classification and evidence.

“Validated payroll calculator” is the optional external adapter for a payroll profile explicitly using an external calculation method. Native payroll selects its package by country, tax jurisdiction and pay date. Legacy Alberta profiles can also select the published 2027 withholding package without the adapter. The Preview runs against Supabase. In-memory PostgreSQL is used only by isolated automated tests.

## Follow-up preview

The public pages use the production source and assets. The QA database received a copy of the published homepage and active service/market catalog. The copy contains only public-facing fields and uses existing QA permissions. Corporate page content was compared with the live homepage, service listing, country listing, About, Contact and both customer account entry pages.

The staff update adds:

- Per-day reviewed leave allocations across compatible policy transitions, daily accrual using dated rates, and a verified counting method for approved days actually worked. Specialist eligibility days, exceptions or encashment outside the supported method need an independently reviewed correction or a separate verified calculation.
- Calculated carry-forward proposals for opted-in categories, capped at the new cycle's policy and requiring independent review. Previous-cycle entitlement, cap and rule evidence are rechecked before posting. Setup is in Governance → Employment policies → Leave adjustments.
- Same-pay-period changes to the applicable overtime multiplier when daily and weekly thresholds and the workweek remain compatible. Each used rule is retained in the payroll snapshot. Changes to the workweek, overtime thresholds, assessed employment assignment or governing pay-standard method still require a reviewed boundary or calculation.
- Payroll reconciliation of the paid status and minutes in authorized leave allocations, and detection of completed attendance missing a timesheet before payroll calculation.
- An audited project export with explicit project view/export delegation and overdue milestone counts. Attendance exports enforce their own delegated permission in addition to record visibility.
- Additive migration `20261125101811_reviewed_leave_carry_forward.sql` stores evidence for calculated carry-forward adjustment proposals in the QA schema.

## Review paths

| Area | Where to test | What to verify |
| --- | --- | --- |
| Projects | Staff → Projects | Create a dated project, assign an owner, add and complete milestones, close related tasks, submit, return/approve with an independent account, archive and restore. Search and filter by name, status and deadline. |
| Time follow-up | Overview → Expected time records → Review exceptions | Past published shifts and completed attendance are reconciled separately. An absence follow-up does not create paid time. Approved whole-shift leave and explicit excuses are excluded. |
| Employment assignment | Governance → Employment policies → Employee assignments | Enter actual worksite, assessed employment jurisdiction, worker category, schedule and evidence. An actual workplace needs a geographic subdivision. Federal jurisdiction is a distinct legal selection. |
| Policy coverage | Governance → Employment policies → Coverage | Check an effective date and see applicable version, expiry and official source. Published tax packages still require verified employee and employer inputs. A missing qualification or date blocks the relevant processing. |
| Payroll | Salary & payroll → Employer validation, statutory inputs and payroll periods | Independently approve actual employer registrations, verified scheme applicability, facts and balances. Run the draft, reconcile it to official results, then use an independent approver and finalizer. |
| MFA recovery | Governance, using a separate Super Admin | Verify identity outside the portal. Record an opaque case reference. Authenticate with current password and fresh MFA. Recovery revokes earlier sessions, factors and credentials, and gives a single-use code for fresh enrollment. The audit records the reference fingerprint. |
| Email delivery | Settings → Integrations and personal notification preferences | In-app notices remain available. See [sender DNS and activation](notification-email-setup.md). Opt-in creates recipient-specific outbox state when a sender is configured. |
| File security | Settings → Integrations, Documents and Privacy | Authorized access to existing objects remains available. New uploads require a clean scan and fail closed when the scanner is unconfigured or unhealthy. |

## Module and verification scope

| Staff area | Available workflows | Remaining acceptance or dependency |
| --- | --- | --- |
| Access and people | Passwords, MFA, activation and recovery codes, sessions, employment end and suspension, scoped employee and compensation profiles | Optional SSO configuration and live verified activation/recovery email |
| Messaging and calls | Direct/group/project/department channels, scoped permissions, retention, document references, LiveKit meeting controls, admission, consent and recording access | Two-device media, preview webhook delivery, real recording and expiry run |
| Documents and privacy | Private permissions, previews, key rotation, archive/export/hold, exact reviewed disposal and audit receipts | Provision and validate a persistent ClamAV gateway. External copies and backups follow their own legal retention. |
| Tasks and projects | Task timers, reviews, document links, deadlines and new project approval workflow | Project reporting is scoped to projects, milestones and visible task totals |
| Attendance, leave, holidays and calendar | Clocks, work/break policies, shifts, swaps, corrections, approved hours, leave accrual and reviewed adjustments, rule dates, reports | Local law and employee category coverage, automatic specialist accrual/carry, mixed-rule intervals and special schedules |
| Payroll | Compensation history, period calculation, country methods, native and configurable additional levy assessments, approval/snapshots, payslips, recorded payments | Employer facts, supported regional laws and reconciliation. Bank movement and statutory filings use separate integrations. |
| Administration and reporting | Scoped staff authority, payroll/privacy rules, overview exceptions, independent approvals, audit search and export | Additional statutory algorithms, cross-module grant/report coverage, complete accessibility and realistic load acceptance |
| Reliability | Provider preflight, isolated application tests and the recovery drill below | Hosted backup/restore drill, operational recovery policy and signed-off browser/device testing |

## Statutory scope

| Country | Geography | Implemented methods | Approval or missing coverage |
| --- | --- | --- | --- |
| Canada | Ten provinces, three territories and federal employment | Fourteen holiday calendars, standard Alberta employment examples and 2026 withholding across 13 regions. January 2027 CRA package for the 12 non-Québec regions. | Québec 2027 payroll requires a reviewed Revenu Québec package. Validate tax province separately from employment jurisdiction. Review occupation exemptions, collective arrangements and special calculations, including cross-province pension adjustments. |
| India | 28 states, eight union territories and central employment | FY 2026–27 new/old salary withholding, EPF/EPS, ESI and reviewed professional tax or extra levy configuration | Review each worksite, covered class, thresholds, wage basis, exemptions and state-specific employment and levies. Some specialist statutory calculation methods require code or a validated adapter. |
| Pakistan | Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan, Azad Jammu and Kashmir, and federal employment | Tax year 2027 salary withholding, EOBI and reviewed local scheme/levy configuration | Validate employer registrations, EOBI wage basis and provincial social-security/occupation coverage for each site. Add reviewed successor packages by fiscal year. |

Country packages use payment dates. Work rules use the applicable date and preserve approved historical snapshots. Split intervals at policy or assignment boundaries where the calculation cannot safely combine rules. Super Admin can maintain supported jurisdiction, employer, classification, policy, payroll, permissions and retention configuration. Published mandatory coverage and finalized payroll have independent review and history guards. Prior-year rates are never treated as the new year's rules.

Before real payroll, collect the legal employer entity and registration IDs, worksite/sector and worker categories, official applicability evidence and scheme exemptions, compensation and schedule, employee declarations, verified year-to-date opening balances, prior employer records as applicable, and signed reconciliation with an independent reviewer. The sample Canada, India and Pakistan tests exercise synthetic employers and employee inputs.

## Preview database and recovery

The application changes are in the workspace API, project and workforce views, employment policy resolver, country payroll packages and staff authority. Added SQL `20261125093948_project_lifecycle_and_workforce_reporting.sql` extends project records, adds private milestone rows and indexes time follow-up queries. Existing SQL `20261125075353_notification_email_outbox.sql` is installed in this preview for notification delivery and preferences. The preview rollout selects only the isolated schema, checks reciprocal production isolation and grants the new tables only to the QA runtime under row-level policies.

Supabase database backups contain Storage metadata. Protect the private document, recording and export bytes with separate backups.

1. Establish approved recovery objectives, custodians and encrypted destinations for the project. Capture a consistent logical database export with the supported Supabase or PostgreSQL tool. Capture private objects separately with a manifest of keys, versions, sizes and content hashes. Store the two artifacts and metadata under a common checkpoint ID.
2. Verify the deployment build and exact migration versions alongside the backup. Keep DB role provisioning and integration encryption keys in the authorized secret store. Exclude secrets from logs, screenshots and ordinary backup documentation.
3. Restore first into a disposable database schema and private bucket with fresh test credentials. Replay the schema/data in dependency order, apply the intended grants and row policies, restore the private objects, and test authorization and content hashes.
4. Verify payroll snapshot totals, one representative file and version from each protected bucket, a disposable meeting recording, login/MFA and role boundaries. Compare the manifests and record restore time, missing data and corrective steps.
5. Preserve documented legal holds and approved disposal receipts during restoration. Use an authorized process to reconcile objects/data created or disposed of after the backup before exposing any recovered service.
6. Delete disposable drill assets only after recording acceptance. A production restore or production promotion requires separate owner approval.

[Database backup and restore reference](https://supabase.com/docs/guides/platform/backups) · [Private storage object export reference](https://supabase.com/docs/guides/storage/management/download-objects)
