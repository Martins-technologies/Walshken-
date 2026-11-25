# Walshken

Standalone corporate website and staff operations workspace built with Next.js, TypeScript and PostgreSQL. Vercel builds from the repository root. The production domains are configured separately.

## Frontend review

Open the corporate homepage at `/`, the service directory at `/services`, country availability at `/countries`, and the About and Contact pages at `/about` and `/contact`. Every published catalog entry has a division page, and every supported ISO country has a direct availability link. Open the database-backed staff portal at `/staff`.

## Local development

1. Run `npm ci` using Node.js 22.
2. Copy `.env.example` to `.env.local`. Set a local administrator email, a unique random setup code of at least 24 characters, and an integration encryption key if you want to test credential storage.
3. Set `DATABASE_URL` to the dedicated Supabase development database and run `npm run dev`. Automated tests use disposable in-memory fixtures.
4. Open `/staff` and set up the first administrator. Use Employees to issue staff activation codes. Use separate browser sessions for role checks.

## Vercel and Supabase

- Create a dedicated PostgreSQL database for Walshken. Keep Preview and Production databases separate.
- Run `npm run db:migrate` with a direct or session-pooler database URL before enabling staff access. Apply migrations using the schema owner.
- Add `DATABASE_URL` to the matching Vercel environment. Configure Preview with its own database and apply the staff migrations there before review. Use the Supabase transaction pooler for serverless requests. The adapter disables prepared statements.
- Configure `WALSHKEN_ADMIN_EMAIL`, `WALSHKEN_SETUP_CODE`, and a separate 32-byte base64 `WALSHKEN_INTEGRATION_KEY` as protected environment variables. Remove the bootstrap code after initialization and redeploy. Set `WALSHKEN_REQUIRE_STAFF_MFA=1` to require enrollment before staff can use the workspace. Recover accounts with an admin-issued reset code or a saved authenticator recovery code.
- The company site can render the initial catalog while the database is pending. Staff access and inquiry submissions require the database.
- The Data API can stay disabled. Only the server connects to PostgreSQL. The initial schema enables RLS and revokes Data API role grants on the workspace tables. Review the database runtime grants before handling production records.

## Market publishing and search

- Use Admin → Website services to maintain homepage copy and published services. Use Admin → Country availability to enable each launch market, set contact details, and publish available services and destinations. Visitors can search any supported country by name or ISO code.
- The public site lists a country as available when it has a published service. Unlaunched countries can receive expressions of interest once the database is connected.
- For the production launch, set `WALSHKEN_SITE_URL` to the verified HTTPS origin and `WALSHKEN_INDEX_PUBLIC=1` in Production. Redeploy, then verify `/robots.txt` and `/sitemap.xml` on the custom domain. The sitemap lists canonical public pages and eligible published markets. Preview and staff pages carry noindex directives.
- Set provider credentials in the protected workspace under Admin → Integrations. Change your workspace password under My profile. The password change ends existing sessions.

## Implemented in this build

- Country autocomplete with ISO codes, market and service availability, configurable destinations, public inquiries and launch interest.
- Account activation, scoped roles, password sign-in, expiring server-side sessions, account suspension, self-service password changes and admin-issued reset codes.
- Profiles, organization units, projects, tasks and discussions, work calendars, shifts, attendance and breaks, timesheet submission and review, leave requests, notifications.
- Membership-scoped direct messages and group conversations backed by PostgreSQL. Start one from **Messages → New message → Direct**. Group-creation policy is independent of direct messaging.
- Private, versioned documents with server-side access checks and previews. Chat document references require both `WALSHKEN_DOCUMENTS_ENABLED=1` and `WALSHKEN_MESSAGE_DOCUMENTS_ENABLED=1`. Apply the document-reference migration first. A chat reference preserves the document’s existing permissions.
- Secure LiveKit calls and meetings with participant roles, attendance and optional consent-based recording.
- Reviewed payroll estimates, effective-dated rates, adjustments, payslips and country statutory packages for Canada, India and Pakistan. Employer/workplace applicability, actual employee declarations and effective coverage must be independently reviewed before finalization. Payments recorded in the app are processed separately.
- Granular sensitive-action permissions, employment-rule evidence, privacy exports and archives, legal holds, and approved original-record disposal.

## Production readiness

Run `npm run verify:release` with Node.js 22 for TypeScript, isolated regression suites and production compilation. GitHub CI runs the same gate, and every Vercel production build runs the regression suites before provider preflight. The test runner excludes deployment credentials and database connections from fixtures. See [production release instructions](docs/production-release.md) for migration, environment and rollback requirements.

Verify connected provider workflows using authorized test accounts in a separate database. Operational acceptance includes backup restore, runtime permissions, session recovery, retention and capacity. Live malware scanning is explicitly deferred for the current release; set `WALSHKEN_MALWARE_SCANNING_REQUIRED=0` to retain document functionality with existing file validation and private access controls. The automated call and document suites substitute provider transport while testing real routes and permission checks.

## LiveKit calls and meetings

See [calling review and connection instructions](docs/livekit-calling-review.md). Configure LiveKit and private recording storage through the encrypted admin Integrations screen. Run `npm run test:calls` for backend authorization, signatures, attendance and recording-policy regression checks. Actual media and storage acceptance require the connected providers and two browser sessions.
