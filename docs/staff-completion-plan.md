# Staff completion plan and database impact

Production baseline is commit 2e6480cb78fac8e9bc8799fbd64b996e3e240fda. The review branch contains the audited provider identifier fix, standard Alberta reporting pay, policy history, governance and oversight work. Production deployment requires separate approval.

## Implementation order

1. Reconcile production integrations and current database state.
2. Extend the existing jurisdiction evidence/version records with typed calculation settings and reviewed approval history. Add the complete three-country geographic hierarchy and effective employee employment assignments.
3. Resolve policy by actual workplace, classification and effective date. Reuse it for working time, overtime, holidays, calendar and payroll. Reject missing, overlapping, expired and withdrawn coverage.
4. Add structured policy authoring, comparison, duplication, supersession and review controls. Preserve mandatory requirements and historical calculation evidence.
5. Add leave accounting and retained adjustments, broader granular permissions and retention/legal holds.
6. Complete scanner quarantine, delivery and provider acceptance using real connected services.
7. Execute regression, jurisdiction, role, provider, browser, recovery and load acceptance. Report each result separately.

## Database impact

Add three-country country/subdivision metadata and effective employment assignments. Extend existing staff jurisdiction versions with category, typed settings, content hash, mandatory status and predecessor links. Preserve existing evidence and all finalized payroll. Add indexes and immutable-history protections. New relations have foreign keys, RLS and explicit grants only for the isolated review runtime during this phase. No production rows or schema are changed by review deployment.

Country and subdivision rows describe geography. Their existence does not verify legal coverage. Statutory packages retain official sources, coverage, effective dates and approval decisions. Unverified settings cannot authorize payroll finalization.

## Rollback

Reassign the review branch to its previously verified commit. New database objects remain available for diagnosis. No destructive down migration is required. Before production DDL, verify provider backup availability and a restore path, present schema and data impact, and obtain the user's production migration approval.

## External acceptance

Existing production LiveKit and private S3 settings must be reused through secure configuration. Preview secrets cannot be reconstructed from inaccessible saved Vercel Secrets. A real malware service/worker and verified email sender are required for those live workflows. Provider status requires successful authentication and actual contract-compatible transactions. Country-wide statutory readiness also requires verified workplace and employee-category coverage, including regional tax/contribution and establishment rules.

## Continuation scope — 25 November 2026

The owner has requested completion of country payroll, granular authorities and privacy workflows before any production merge. Work remains on the isolated review branch and schema. Each country calculation must preserve its actual effective tax year, fiscal year, employee elections and statutory applicability. Country-specific contribution bases and approved payroll inputs must be captured, not inferred from portal roles.

Live malware scanning was explicitly deferred by the owner in this continuation. Only the review branch receives `WALSHKEN_MALWARE_SCANNING_REQUIRED=0`; private storage, access checks, format/content validation and secure previews stay active. No deferred upload is labelled scanned or clean.

Implementation sequence: independent sensitive-action permissions; dated Canadian provincial and Indian/Pakistani tax and contribution engines; payroll integration and audit snapshots; approved privacy export/archive/disposal requests; role and negative authorization regressions; hosted review deployment and manual test access. Production remains unchanged.

## Review implementation — 25 November 2026

- Added separate, employee-scoped authorities for attendance editing, correction approval, timesheet approval, salary history, payroll operations, privacy and audit exports. Explicit denial wins; sensitive directory fields are masked without the separate permission.
- Added current-year Canadian regional tax packages, including Québec/QPP/QPP2/QPIP, and India/Pakistan fiscal-year tax packages. Reviewed per-period statutory elections, monthly cumulative contribution ceilings and employer/employee split ledgers are stored immutably at finalization.
- Added verified effective Pay standards for regional wage floors, holiday reference windows/divisors/premiums, vacation minima, payment deadlines and reporting pay. Native payroll requires applicable reviewed workplace policies; publishing a country in the catalog does not establish legal coverage.
- Added independently authorized personal-data exports, integrity-checked private archive snapshots, restored private copies, retention/hold-protected archive revocation and durable physical-object cleanup. These archive operations preserve source payroll/audit records; operational-record disposal is not represented as implemented by snapshot disposal.
- Live malware scanning explicitly deferred by the owner. Review-only `WALSHKEN_MALWARE_SCANNING_REQUIRED=0` allows format-validated uploads, records the deferral and never creates a clean verdict. Default deployments continue to require a scanner.

Validation: country calculation boundary tests; published Québec regular-pay example; complete synthetic Canada/Ontario, India/Delhi and Pakistan/Punjab salary workflows through independent review/finalization; private-storage transport tests covering exports/restores/holds/cleanup; all six staff-role authentication tests; document, messaging, calls, task, attendance, payroll and holiday regression suites; TypeScript and Next.js build. Synthetic statutory fixtures validate execution paths, not the legal completeness of employer-specific policy choices.

Remaining acceptance boundaries: reviewed employer/worksite/employee applicability and regional contribution configuration for real staff; legal certification of occupation-specific and exceptional payroll cases; original operational-record disposal workflows beyond protected archive-copy destruction; hosted multi-party camera/microphone and recording acceptance; actual bank remittance and jurisdiction-specific tax filing/remittance integrations if required. No blanket 100% legal-compliance claim is made. Production stays at commit `2e6480cb78fac8e9bc8799fbd64b996e3e240fda` until the owner approves a merge.
