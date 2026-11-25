# Original-record disposal and employer validation review

25 November 2026 · Preview only · Production baseline `2e6480cb78fac8e9bc8799fbd64b996e3e240fda` remains unchanged.

## Original source disposal

The Privacy module now supports exact, hashed manifests for employee records, attendance, timesheets, payroll/payslips, documents, audit history, messages, meeting metadata and leave. A different authorized reviewer must approve the frozen manifest. Execution requires the explicit destruction phrase, locks source rows, and checks current permissions, retention, legal holds and finalized-payroll dependencies again. A changed source or retention decision invalidates the approval. Open clocks, pending decisions and unfinished payroll cannot be destroyed.

Original content is deleted from source tables; shared message bodies and ended-account identity are redacted. Minimal pseudonymous record references and immutable destruction receipts remain where required for shared threads and audit integrity. This is a scoped record-disposal workflow, not a claim that every business reference to a person is anonymous. Select All only when every included category is legally eligible.

Documents and recording objects are queued for physical private-storage deletion. The queue records the original storage location, retries failures and reports completion only when all objects are deleted. Storage configuration changes cannot silently redirect the job. Cleanup is serialized against new legal holds. Backups, object-provider recovery copies and copies already lawfully downloaded follow the provider's separately controlled retention; a portal deletion does not erase those external copies.

Financial records have conservative statutory floors in addition to independently reviewed company retention: six years after the relevant tax-year end for Canada/Pakistan and eight financial years for Indian company books. Longer requirements, late-filed returns, investigations, litigation and applicable employer-specific exceptions must be reflected in longer reviewed retention or a legal hold. The portal does not offer early-destruction authority from a tax agency.

## Legal employer and employee statutory validation

Payroll → Statutory validation provides structured legal-entity registration, workplace, sector, headcount, historical coverage, country elections and scheme-applicability forms. Every required scheme must have an explicit covered/exempt/not-applicable decision, official country source and supporting evidence. Employer versions and employee facts are independently reviewed and immutable. Multiple employing entities in the same country are bound through the employee's selected employer version. A withdrawn/stale version cannot silently authorize a new payroll.

Canada checks reviewed CPP/QPP, EI/QPIP coverage, TD1/SIN verification, actual pension/insurance exemptions, contributory months and the employer EI multiplier. Additional WCB, Québec HSF/labour contributions and relevant provincial/territorial levies are assessed explicitly. HSF rates reconcile to reviewed worldwide payroll and sector.

India checks PAN/TAN format, EPF continuing/mandatory establishment coverage, notified 10/12% rates and evidence, employee PF/EPS membership, international-worker ceiling treatment, ESI contribution-period coverage and actual contributory wage allocation. Missing/inoperative PAN uses documented higher withholding rather than ordinary PAN rates. Professional tax and labour-welfare applicability require explicit assessment.

Pakistan checks the employing entity's NTN, reviewed EOBI establishment threshold/continuing coverage, actual employee insurability and the notified federal contribution wage basis. Provincial social security and professional/employment-tax applicability require an explicit assessment.

The period contribution assessment reconciles configured additional levies against independently reviewed employer and employee opening balances, contribution ceilings/exemptions, prior finalized payroll and current source hashes. A different authorized reviewer must approve the assessment before submission/finalization. Salary statement responses and personal exports omit employer-group payroll figures, including nested source snapshots.

Super Admin can create dated versions, delegate employer-management/review permissions, record evidence, withdraw future use and maintain jurisdiction policies. Decisions and finalized history cannot be silently edited. A lawful exemption is supported evidence, not a switch to disable mandatory employee entitlements.

## Required operational facts

Before a real pay run, the employer must supply and independently verify its legal registrations, actual worksites/employee categories, coverage/exemption evidence, payroll declarations and opening balances. Registration format checks do not authenticate registrations with government systems. No live government registration-verification, statutory filing/remittance, bank transfer or accountant certification is implied. A reviewed supported native rule package or the configured validated payroll-provider contract is required for specialist treatments the engine does not support; unsupported cases stop with an explanation.

No new third-party API is required for these two workflows. Existing private S3 storage is reused. Live malware scanning remains explicitly deferred at the user's direction.

## Validation

`npm run test:completion` exercises source manifests, denied/self/stale approvals, current legal holds, country financial-retention boundaries, immutable-history preservation, source-table destruction, cyclic document/version dependencies, S3 failure/retry/completion and ended-account credential removal. It also runs complete Canada/Ontario, India/Delhi and Pakistan/Punjab synthetic salary workflows with independently approved employer/facts/levy assessments and finalized employee statement privacy checks.

`npm run test:country-payroll` checks Canadian regional packages, India regimes/rebates/higher-PAN withholding, Pakistan slabs, contribution caps/rounding and fiscal years. Synthetic fixtures demonstrate implemented workflow behavior and arithmetic; they are not verified client employer facts or a country-wide legal compliance certification.
