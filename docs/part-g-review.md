# Part G — salary and payroll

Extend the canonical compensation and payroll records on top of Parts E/F. Preview only in Martins-technologies/Walshken-, existing walshken Vercel project and Supabase ssggjxyexwkshtcypsaq. Existing people, MFA, production code, production variables and pay records remain untouched. No synthetic work, salary, payroll or payment data is deployed.

## Calculation and controls

Use effective-dated, append-only rates and policy profiles for employee/contractor classification, employment jurisdiction, currency precision, workweek, salary proration, overtime, holiday, vacation and paid-leave rules. Hourly earnings use approved Part F intervals split at local midnight, with paid/unpaid break totals kept separately. Alberta standard overtime uses the greater of daily eight-hour or weekly forty-four-hour overtime without double counting; the workweek calculation includes days outside pay-period boundaries. Salaried employees retain overtime eligibility unless a documented occupational exemption applies. Contractors have explicit contract-hourly or period-fee rules and do not inherit employee CPP/EI deductions.

Canada/Alberta standard payroll is the initial native earnings/deduction engine. Tax year 2026 uses versioned CRA T4127 regular and non-periodic calculations, TD1 claims, additional withholding, pensionable/insurable earnings, CPP/CPP2/EI limits and reviewed opening YTD balances. Rates do not roll into another tax year or jurisdiction silently. Other countries/provinces and special cases use separately configured, reviewed rules plus a validated external calculator result; CPP/QPP and EI/QPIP remain distinct deduction codes. The provider adapter must verify its response against the exact payroll input and never substitutes zero deductions when unavailable.

Pay periods support weekly, biweekly, semimonthly and monthly. Draft calculations are estimates. Submitted monetary rows require scoped payroll-role approval by someone other than the employee receiving the pay. Period finalization checks source hashes again, verifies every employee row is approved and freezes the calculation. An employee may finalize a technically complete period only after another authorized payroll user has approved their own monetary row. This avoids self-approval without requiring a third approver for a two-person payroll team.

Bonuses, paid-leave amounts, holiday decisions, deductions and adjustments are real, explicitly authorized entries. Statutory holiday eligibility/average daily wages are based on reviewed history, not invented from hire date alone. Missing or unapproved source inputs block approval. Vacation percentages cannot undercut the applicable Alberta tenure minimum. Salary/holiday/paid-leave earning lines identify included base salary to prevent double payment. Currencies are kept separate; there is no unapproved automatic FX conversion.

Finalized records cannot be silently edited or deleted, including through direct runtime SQL. Rate/profile history, approval decisions, statements, source revisions and activity are retained. A later attendance correction creates a reconciliation obligation for a new auditable payroll adjustment; it never rewrites a finalized statement. Payment status records confirmed external payments and reversal entries with dates/references; this module does not initiate bank transfers.

Employees see their own approved timesheets, released earnings statements and pay history. Payroll administrators see only their scope unless explicitly granted organization-wide payroll access. General administrators, managers and guests cannot read another employee's salary/tax records. Payslips are real private PDF downloads; reports export actual payroll data with currency-separated totals.

## Sources and maintenance

- CRA 2026 T4127: https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/payroll-deductions-t4127-payroll-deductions-formulas/t4127-jan-122nd-edition-effective-january-1-2026/t4127-jan-payroll-deductions-formulas-computer-programs.html
- CRA July 2026 update (Alberta unchanged): https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/payroll-deductions-t4127-payroll-deductions-formulas/t4127-jul-123rd-edition-effective-july-1-2026/t4127-jul-payroll-deductions-formulas.html
- Alberta overtime: https://www.alberta.ca/overtime-hours-overtime-pay
- Alberta holidays: https://www.alberta.ca/alberta-general-holidays
- Alberta vacation: https://www.alberta.ca/vacation-pay

Tax-year rule packages must be verified and tested before activation for a new year. A payroll reviewer must verify classifications, tax elections, opening balances and exceptional remuneration before finalization. Calculation review is never labelled government certification.

## Review workflow

1. Sign in with the existing staff account and authenticator. Open Administration → Salary & Payroll.
2. Save actual employer legal details. Select each real employee and record the verified policy, effective rate, and all actual opening YTD balances. A confirmed zero is entered explicitly, never seeded.
3. Create a period and select its actual roster. Review Parts F timesheets first. Add and approve actual bonuses, deductions, holiday decisions and paid/unpaid leave allocations. For a salaried employee, approved leave must be classified explicitly. Vacation already paid with each payroll must not be paid a second time for the same vacation leave.
4. Calculate the roster. Review the earnings/deduction breakdown and source issues. Submit, have an authorized user other than the payee approve each row, then finalize the complete approved period.
5. Employees receive an internal notification and see their finalized statement, private PDF payslip, approved timesheets and pay history. Record only confirmed external payments; incorrect payment records are reversed with a new ledger entry.
6. Corrections to finalized attendance create payroll reconciliations. A new approved adjustment resolves the reconciliation when that new payroll is finalized. Historical statements remain intact.

The UI shows recent history (up to 1,000 statements); selecting a period shows its complete roster. CSV exports query the actual complete scoped register, up to 100,000 rows before requiring a narrower period. Currencies are never added together as if they were equivalent.

## Verification

`npm run test:payroll` uses an isolated PGlite database, with local-only accounts and source records. It covers official CRA regular/above-YMPE examples, non-periodic pay, exact minor units, future-year guards, approved work, overtime and breaks, effective rates, input and independent monetary approvals, stale sources, immutable statements/snapshots/payments, private valid PDF/CSV exports, payment reversals, explicit paid/unpaid salary leave, holiday-only pay, workweek boundaries, contractor fees and USD isolation. The production-role RLS test confirms that Preview salary/payroll is invisible to that role. Earlier staff, messaging, LiveKit, document, task and workforce suites pass. The optimized Next.js build and TypeScript checks pass.

No test employee, salary, payroll, attendance, payment or provider connection is inserted into the hosted database. Owner sign-in and manual acceptance use the existing credentials and MFA; no factor is copied or reset for testing.
