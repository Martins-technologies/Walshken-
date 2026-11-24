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
