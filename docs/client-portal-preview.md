# Walshken Client Portal Phase 01

The existing customer account becomes the Client Portal when `WALSHKEN_CLIENT_PORTAL_ENABLED=1`. The public website continues to link to `/customer`. Authorized staff reach Client casework from `/staff/client-casework`.

## Review workflow

1. Sign in with a verified QA client, start a case, submit a PDF, JPEG or PNG, and view the document history.
2. A Super Administrator opens the new case, assigns an employee and sets a company-approved representative name. The assignment controls case membership immediately.
3. The assigned employee can review documents, create requests, write internal notes, propose client-facing updates and use the case conversation. An authorized, different reviewer approves public updates. The client sees the approved text and public status.
4. Use the authorized case staff account to send the test client a message. If a Preview LiveKit project is connected, try both directions with two devices and test audio, video, decline, missed calls and reconnects. Client tokens grant camera and microphone according to call mode.
5. Create an invoice and an agreement in Staff casework. Use the client's Finance pages to open the invoice, sign the exact agreement version and retrieve the signed copy. For online payment, connect Stripe Sandbox and register its signed webhook first.
6. Submit a privacy request from the client account and process it as a Super Administrator. Approved data access uses fresh password verification. Cover legal hold and independent release before testing disposal.

## Data boundary

Preview uses a dedicated private schema and non-owner database login, both scoped to `walshken_client_qa`. The web application rejects mismatched Preview database identity before accessing the catalog or portal. The setup scripts under `ops/preview` provision empty schema structures, service catalog data and fictional QA identities. They do not copy staff accounts, client records, payment history or storage. The new browser API routes use server-side ownership and role checks. Client case, document, finance and calling transactions also set a client row-level security context.

Document uploads in this Preview use the protected QA database object table. Originals are versioned and kept private. Client previews are rasterized server-side with a session-specific confidentiality watermark. The app conceals sensitive views on blur and checks the session before revealing them. Browser measures cannot prevent operating-system capture, external photography, or copying by an authorized viewer.

Authorized retention and hold workflows provide evidence for disposal. Publish organization-approved privacy notices and retention terms before collecting real documents. Decisions about access, retention and exceptions depend on where the organization operates and the purpose of each record. Canadian guidance includes the [Office of the Privacy Commissioner retention principles](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_use/) and applicable provincial rules. Confirm the client agreement and signature requirements for any regulated forms before accepting them digitally.

## Preview configuration

| Capability | Preview setup |
| --- | --- |
| Client accounts and profiles | Scope `DATABASE_URL`, `WALSHKEN_CLIENT_PREVIEW_SCHEMA`, `WALSHKEN_INTEGRATION_KEY_V2` and `WALSHKEN_CLIENT_PORTAL_ENABLED` to this branch. Use provided fictional accounts until a sender is configured. |
| Email OTP, reset and optional email alerts | Save a verified, isolated Resend sender in Integrations, or set Preview-scoped `WALSHKEN_CLIENT_RESEND_API_KEY` and `WALSHKEN_CLIENT_RESEND_FROM`. One-time verification codes are short-lived and rate limited. Resend acceptance is reported separately from delivery to the final inbox. |
| Private documents | `WALSHKEN_CLIENT_PREVIEW_DB_OBJECTS=1` uses private QA database bytes. A separately scoped S3-compatible bucket can be configured in Client document storage. Preview can defer malware scanning for fictional files. A required scan rejects uploads when the gateway cannot verify the file. |
| Audio and video | Use a dedicated Preview LiveKit project in Integrations. Register the Preview `/api/livekit/webhook` endpoint and configure representative and office/support routing. Use fictional accounts for calls. |
| Online payments | Add a Stripe Sandbox API key and signed snapshot webhook secret in Integrations. Subscribe `/api/client-finance/stripe` to Checkout Session completion, async success/failure and expiry. Checkout redirects to Stripe and Walshken never handles card details. The backend verifies events before changing invoice status. |
| Electronic signatures | No provider is needed for the built-in agreement workflow. The retained PDF and evidence bind the signer, exact version, consent, timestamp and agreement fingerprint. |
| Background processing | With the case-specific Preview `CRON_SECRET`, run `/api/livekit/maintenance` from an authorized scheduler to process email retries, stale rooms, old OTP challenges and document object cleanup. No production scheduled job is changed by this branch. |

Use only fictional documents while scanning is deferred in Preview. Never enter production provider keys into the QA project.

## Automated QA

Run `npm run typecheck`, `npm test` and `npm run build`. The client test suites cover identity, cases, documents, calls and finance. `node ops/preview/build-client-preview.mjs verify` runs migration and cross-tenant access checks in an isolated PostgreSQL-compatible engine. Hosted provider actions require the configurations above.
