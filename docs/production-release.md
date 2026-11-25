# Production release — 25 November 2026

The owner authorized completion and deployment to the existing Walshken Vercel project without another approval step. The canonical public URL is https://www.walshken.com; staff sign in at `/staff`. This release preserves the existing design, accounts, passwords, authenticator factors, encryption keys, LiveKit service and private storage objects.

## Release contents

The reviewed branch includes staff access and granular authorities, messages and calls, private documents, tasks, attendance and scheduling, holiday and employment rules, payroll workflows for Canada, India and Pakistan, governance, privacy export/archive/restore, and approved original-record disposal. Employer statutory validation checks real registrations, applicability and supporting evidence before payroll approval. Missing employer or employee inputs stay visibly incomplete; deployment does not create fictitious registrations, payroll balances or independent approvals.

Live malware scanning remains explicitly deferred by the owner. Production must set `WALSHKEN_MALWARE_SCANNING_REQUIRED=0` so authorized uploads, previews, sharing and downloads continue to work. Existing private storage, access checks, file/content validation and safe rendering remain active. Deferred files are not labelled scanned or clean. A future scanner rollout needs its own real service and acceptance checks.

## Database and configuration

The existing Supabase project is `ssggjxyexwkshtcypsaq`. Production uses schema `public` and runtime role `walshken_production_app`. The isolated preview uses `walshken_role_qa` and its own runtime. Never assign a preview database URL or a preview dataset to a production deployment.

Apply these additive migrations to production before enabling the new workflows:

1. `20261124192707_staff_readiness.sql`
2. `20261124211828_dynamic_employment_engine.sql`
3. `20261124223624_enterprise_payroll_privacy_workflows.sql`
4. `20261125053842_source_disposal_employer_validation.sql`
5. `20261125075353_notification_email_outbox.sql`

Review table-level grants after applying the schema. New tables require RLS and organization-scoped production-runtime policies, with preview/production dataset boundaries preserved. Close anonymous/authenticated Data API grants. Original-record disposal requires the approved, integrity-checked manifest and retention/legal-hold checks; do not grant an unrestricted deletion shortcut. These schema migrations do not dispose of existing records.

Keep existing protected `DATABASE_URL`, `WALSHKEN_DATABASE_CA`, encryption keys and `CRON_SECRET` values. Never reset MFA or regenerate integration credentials as a release step. Bootstrap and legacy-key migration remain disabled unless an independently required account-recovery or migration operation has been authorized.

Required production configuration:

| Setting | Production value or requirement |
| --- | --- |
| `WALSHKEN_SITE_URL` | `https://www.walshken.com` |
| `WALSHKEN_INDEX_PUBLIC` | `1` |
| `WALSHKEN_REQUIRE_STAFF_MFA` | `1` |
| `WALSHKEN_RELEASE_SCOPE` | `staff-holidays` |
| `WALSHKEN_DOCUMENTS_ENABLED`, `WALSHKEN_TASKS_ENABLED`, `WALSHKEN_ATTENDANCE_ENABLED`, `WALSHKEN_PAYROLL_ENABLED`, `WALSHKEN_HOLIDAYS_ENABLED`, `WALSHKEN_CALENDAR_ENABLED`, `WALSHKEN_MESSAGE_DOCUMENTS_ENABLED` | Preserve enabled production values |
| `WALSHKEN_WORK_DATASET`, `WALSHKEN_PAYROLL_DATASET`, `WALSHKEN_HOLIDAY_DATASET` | `production` |
| `WALSHKEN_STAFF_READINESS_ENABLED`, `WALSHKEN_EMPLOYMENT_ENGINE_ENABLED`, `WALSHKEN_ENTERPRISE_WORKFLOWS_ENABLED`, `WALSHKEN_EMPLOYER_VALIDATION_ENABLED`, `WALSHKEN_SOURCE_DISPOSAL_ENABLED` | `1`, after production schema and grants are verified |
| `WALSHKEN_MALWARE_SCANNING_REQUIRED` | `0`, reflecting the explicit deferral |
| `WALSHKEN_NOTIFICATION_EMAIL_ENABLED` | `1`, after outbox schema, trigger and runtime grants; every user's email preference remains off until they explicitly opt in |
| `WALSHKEN_STAFF_EMAIL_ORIGIN` | `https://www.walshken.com` |
| `WALSHKEN_VERIFY_SERVER_INTEGRATIONS` | `1`; production preflight verifies the actual production provider settings |
| Document bucket and integration | Preserve `walshken-documents-review` and `document-storage-review`; existing production objects use these identifiers |
| Task and recording buckets | Preserve `walshken-task-files` and `walshken-call-recordings` |

Existing encrypted provider settings take precedence over optional protected deployment defaults, including an explicit disabled state. Do not copy QA provider credentials into production. The custom-domain canonical and public index flag expose real public pages; unpublished markets, staff/customer workspaces, previews and API routes remain excluded from indexing.

## Verification and promotion

Use Node.js 22 and the locked dependencies. Run `npm run verify:release` for TypeScript, all isolated regression suites and production compilation. Individual suites remain available as `npm run test:<name>`.

The test runner passes only basic runtime environment variables to child processes. It excludes database URLs, PostgreSQL connection settings, deployment inputs, credentials and all `WALSHKEN_*` values, then applies only each suite's local fixture flags. Tests create disposable PGlite databases and random test credentials; they never need a production connection. The clock is pinned during test MFA enrollment to avoid asynchronous password hashing crossing a TOTP window while preserving signature and replay checks.

The GitHub verification workflow runs on pull requests, main and Walshken development branches. Every Vercel production build also runs the isolated regression gate before provider preflight and Next.js compilation. A failed, timed-out or terminated suite blocks that build. The local provider transport fixtures are simulations; production provider preflight separately verifies the connected credentials and private storage.

Stage a production-target build from the exact reviewed commit, verify its actual production environment and build logs, then promote that build to the live domain. After promotion check homepage, service/country pages, robots and sitemap, staff sign-in, unauthorized API responses and runtime errors. Confirm the deployment commit and canonical custom domain.

The existing five enabled Supabase schedules cover calling every minute, production/preview task cleanup every five minutes and production/preview attendance cleanup every five minutes. Preserve the signed production calling relay and check job results after release. Privacy/source cleanup is an explicit authorized administration action, not an assumed new cron job.

## Workflow email notifications

Staff choose email notifications on `/staff/notifications`. The preference is off by default and can only be changed by that signed-in recipient. Opt-in applies to new notifications; no existing notifications are backfilled. Opt-out cancels queued, unattempted or retrying deliveries and is rechecked before transport. Emails contain a generic notice and sign-in link, with all sensitive content retained in the authenticated workspace.

The database insert trigger captures both application notifications and production scheduler notifications into a durable outbox. Public-schema preview-stage notifications and legacy preview runtimes are excluded; QA uses its own schema. Apply production runtime SELECT/INSERT/UPDATE permissions and organization-scoped RLS atomically with the trigger. Revoke function access from public/anonymous/authenticated API roles; the trigger is security invoker with a fixed empty search path and schema-qualified dynamic SQL.

The existing authenticated calling-maintenance endpoint processes at most three queued emails per pass within a short time budget. Resend requests run outside database transactions. Each event retains an encrypted immutable payload, a stable idempotency key, a provider-credential fingerprint and a lease. Transient failures retry with backoff up to six attempts, within 23 hours of the first attempt; stale notifications expire after 24 hours. An uncertain send is never replayed under a changed provider credential or to a changed recipient address. Suspended/ended accounts, read notifications and opted-out recipients are suppressed. Delivery activity exposes status and attempt counts without secrets or message content. `Sent` means accepted by Resend, not confirmed inbox delivery.

Production sending still requires an actual verified Resend sender/domain and an encrypted protected API key saved by a Super Admin. The isolated tests use a mocked provider and do not send mail. Missing or disabled configuration leaves email delivery disconnected while in-app notifications remain available. No deployment automatically enables any user's email preference.

## Operational acceptance boundaries

The software retains gates for verified employer/worksite applicability, actual employee statutory elections and independently reviewed opening balances. Those records must come from the organization. Government registration verification, real bank remittance and government tax filing are not implied by an application deployment. Multi-party audio/video and recording acceptance also requires actual devices and participants. Avoid claiming universal legal compliance from synthetic tests.

## Rollback

Pre-release production reference: deployment `dpl_4nfqTb5iJtJW14LYziP2cCAUGkPR`, commit `2e6480cb78fac8e9bc8799fbd64b996e3e240fda`. Record the new deployment and release verification separately after promotion. Roll back to the previous production deployment if the new build fails live acceptance; preserve additive database objects and data for diagnosis. Deployment snapshots retain their original environment values, so verify the chosen snapshot's scheduler destinations, provider settings and schema compatibility. Do not perform destructive down migrations or reset authenticator factors during rollback.
