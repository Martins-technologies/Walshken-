# Walshken Client Portal Phase 02

This release continues from the Phase 01 Preview branch. The existing Staff, Admin and Client sign-ins, integration settings and role model are reused. Review using fictional QA accounts and files.

## Production boundaries

All new migrations are applied to the existing `walshken_client_qa` schema through the `enhancement` mode of `ops/preview/build-client-preview.mjs`. It checks the isolated runtime role and confirms that Phase 01 is installed first. The browser roles, production database login and QA database login have separate access. Client route transactions restrict records to the signed-in customer with PostgreSQL row-level policies. Staff routes verify the active employee, case assignment and privileges at request time. Independent approvals keep internal notes and unpublished case activity separate.

## Workflows to review

- **Journey and family** — In Staff → Client casework → Journey & family, a Super Admin manages the stage catalog and a caseworker proposes a milestone update. A different authorized reviewer publishes it. The client sees approved milestones, actual deadlines, and tasks from their case, documents, billing, agreements and profile. Family records use existing cases and private document versions.
- **Document checks and watermark** — Submit a synthetic PDF, JPEG or PNG. Check an open document requirement, exact duplicate, category mismatch and blurry image. Quality warnings use a readability heuristic, and a human must approve the file. Staff can record verified expiry and request a replacement. Super Admin watermark settings are in the case’s Documents tab. They default to off, render a sample before activation and do not change stored originals.
- **Appointments and calls** — Staff can publish available times and manage a case appointment. Book as a client, reschedule, cancel and download the calendar file. Booking guards cover the assigned host, the selected client and existing Staff events. Appointment joins check participants and the join window before starting the shared LiveKit call. Client audio/video tokens deny screen sharing and recording.
- **External meetings** — Use Staff Calls → Meetings to create a meeting with external recipients. Set the title, description and timezone. Share a secure recipient link manually for fixture testing or deliver through the email provider. A guest can respond, download a calendar file, and join subject to the current event, invite expiry and admission rules.
- **Messages and feedback** — The client can message the assigned representative or a configured office endpoint. Representative messages may reference an authorized private document version. Office access exposes only office communications. Staff receive unread counts and receipt information. Super Admins can review support requests, ratings and complaints from the restricted Feedback & complaints tab.
- **Payments and agreements** — Finance can set an installment schedule and allow partial payments for an issued invoice. Stripe Checkout is the only card entry point and signed payment events control balances. Each verified payment has a private receipt. Existing agreement versions and signature evidence remain private.
- **Languages and security** — Client Portal navigation, main headings and journey titles are available in English, French, Urdu and Hindi. Urdu uses right-to-left layout. Staff → Client casework → Portal settings manages offered languages. Untranslated module controls continue in English. Company content, official records and agreements retain their original text. Clients can enroll a TOTP authenticator, keep single-use recovery codes, inspect recent access and end other sessions. Super Admins can record account suspension and restoration from the registrations tab.

## Provider setup for hosted testing

| Provider | Isolated Preview configuration |
| --- | --- |
| LiveKit | Create a separate LiveKit Cloud project. Add the exact WebSocket URL as `WALSHKEN_CLIENT_PREVIEW_LIVEKIT_URL` on the Preview branch, and save the URL/API key/API secret in the existing LiveKit integration. Register the Preview `/api/livekit/webhook` URL. Configure representative, office or support routing in Client casework. |
| Private storage | With a separate private test bucket, set the exact name in `WALSHKEN_CLIENT_PREVIEW_STORAGE_BUCKET`. Save its S3 endpoint, region and scoped key pair in Client document storage. For an independent Supabase Storage project or provider host, allowlist the exact host with `WALSHKEN_STORAGE_ALLOWED_HOSTS`. Preview currently stores fixture files in its isolated Supabase database until the bucket is connected. File reads use server-side short-lived signatures after authorization when S3 is configured. |
| Stripe | Save a Stripe Sandbox API key and endpoint signing secret in the existing Stripe integration. Register the Preview `/api/client-finance/stripe` webhook for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired`. |
| Malware screening | Connect a dedicated ClamAV gateway and enable required scanning. Preview records screening as deferred until this exists. Only fictional uploads should be used while scanning is deferred. |
| Reminder queue | Invoke authenticated `/api/livekit/maintenance` from a Preview-only scheduler with the existing branch `CRON_SECRET` to process due appointments, payment and document reminders, plus email retries. Run this separately from production scheduling. |

For signed provider webhooks, allow the external provider to reach its Preview endpoint with a deployment-scoped automation bypass or approved ingress. Keep provider keys and bypass tokens out of public links.

## Resend setup

1. Add and verify a domain or subdomain in Resend. Publish the exact SPF TXT, DKIM TXT and SPF MX records from its domain screen. Set a DMARC policy separate from provider verification.
2. Use a sender address from that domain and a sending API key limited to it. Save them in the existing encrypted Resend integration so both Client email and external invitations use the same sender. `WALSHKEN_CLIENT_RESEND_API_KEY` and `WALSHKEN_CLIENT_RESEND_FROM` can override the sender for Preview client email only.
3. For inbox delivery feedback, configure a signed webhook at `/api/client-email/resend`. Add its `whsec_` signing secret as Preview-only `WALSHKEN_CLIENT_RESEND_WEBHOOK_SECRET`. Subscribe to delivered, delivery delayed, bounced, complained and failed events. The notification center distinguishes provider acceptance from these inbox delivery events.
4. Verify OTP and password reset, generic security and case notices, document request/submission updates, invoices, payments, agreements, booking confirmations and reminders, and external meeting invitations and updates. Transactional client notifications use a portal sign-in link. Email code delivery and Checkout still require actual provider setup to test end to end.
