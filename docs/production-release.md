# Staff and collaboration production release

The owner authorized deployment of Part B staff access/profiles, private messaging/groups and LiveKit calls to https://walshken.vercel.app using Supabase project ssggjxyexwkshtcypsaq. Twilio and later modules are deferred.

Production uses a dedicated non-superuser runtime login. It inherits the tested staff/collaboration permissions and has approved server-only access for the existing public catalog, inquiries and customer accounts. Anonymous Data API grants remain closed. Customer records cannot be deleted by this login. The existing published catalog is saved in the database without adding launch markets or invented customer records.

Set WALSHKEN_RELEASE_SCOPE=staff-collaboration to expose the delivered modules, project channels and meeting calendar. Later operational modules are gated in navigation and API routes. Legacy key migration is disabled unless the deployment explicitly opts in with WALSHKEN_ALLOW_LEGACY_MIGRATION=1. Existing authenticator factors are never reset by a release. The new review accounts use the durable V2 key; old preview accounts encrypted with an unavailable legacy key require recovery separately.

The existing LiveKit webhook URL stays unchanged. Its signed Supabase relay supports an explicit production destination https://walshken.vercel.app without a share token or expiry. The production configuration is encrypted in Vault under walshken_calling_runtime_access. The permanent Supabase Cron job invokes the authenticated cleanup endpoint every minute using short-lived HMAC signatures. The temporary review job is disabled after the production relay is verified. Vercel's duplicate cron configuration is removed.

Required production environment: DATABASE_URL, WALSHKEN_DATABASE_CA, WALSHKEN_INTEGRATION_KEY_V2, WALSHKEN_REQUIRE_STAFF_MFA=1, CRON_SECRET, WALSHKEN_RELEASE_SCOPE=staff-collaboration, WALSHKEN_SITE_URL=https://walshken.vercel.app. Public indexing stays off on the test domain until the final .com launch is configured.

Validation: npm run test:staff, npm run test:messages, npm run test:calls, npm run typecheck, npm run build. The suites use isolated databases and real route handlers, password hashing, MFA signatures and authorization checks; LiveKit transport responses in the local suite are simulated. Live release checks additionally cover public pages, private routes, webhook signatures, database writes and the permanent scheduler. Two-browser human audio/video, device and recording acceptance remains the owner's manual check.

Rollback reference before release: production deployment dpl_357bzggTxtX8d2bD86WT3RNBis98, commit c082dd19a43eebfae32cfc65cc9fc0634a803366. Deployment snapshots retain their original environment values. Any rollback also needs the webhook destination and scheduler checked against the chosen deployment; never reset authenticator factors as a rollback step.
