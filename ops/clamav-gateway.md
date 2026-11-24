# Private upload scanner

Run clamav-gateway.mjs with Node 22+ on a private worker hosting ClamAV. Configure FreshClam updates and private ClamD socket access. Keep the ClamD port private. The gateway streams bytes over INSTREAM and accepts only an explicit clean verdict. Engine health verifies signature freshness.

Set CLAMAV_API_TOKEN, CLAMAV_SOCKET (or private CLAMAV_HOST and CLAMAV_PORT), and optionally PORT. Publish the gateway through an authenticated HTTPS reverse proxy at /scan. Add that hostname to WALSHKEN_SCANNER_ALLOWED_HOSTS on the review branch. Super Admin enters the HTTPS endpoint and shared token in Malware scanner under Integrations. Connection testing must succeed before enabling uploads.

There is no antivirus license charge for this option. The worker needs hosting, memory, signature updates, monitoring and an operator. This worker has not been provisioned or tested against a live ClamAV daemon in this workspace. Application transport tests do not constitute antivirus acceptance. Live acceptance must exercise a clean file, the standard EICAR antivirus test file, a digest mismatch, stale signatures, timeouts, and quarantine access controls.

Quarantine objects use a private prefix in document storage. They are never issued download links. Clean originals continue through the existing format validation and upload authorization path. Failed and infected attempts have persistent scan events. Retained private objects require the organization's approved retention procedure.
