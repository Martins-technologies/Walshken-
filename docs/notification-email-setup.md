# Staff notification email activation

Prepared on 25 November 2026 for the existing Walshken project. In-app notifications continue to work. Email delivery requires the sender setup below and each recipient's explicit notification preference. Existing notifications are not backfilled.

## Sender and DNS

A dedicated sending domain, `notify.walshken.com`, has been created in the connected Resend account within its existing three-domain allowance. The domain is **pending DNS verification**. Sending uses the existing account, US East region, enforced TLS, and no open or click tracking. No email was sent during this setup.

The authoritative DNS nameservers are `ns17.domaincontrol.com` and `ns18.domaincontrol.com`. Vercel reports this as an externally managed domain. The available connections do not provide access to its GoDaddy DNS zone.

Add these exact records in the `walshken.com` DNS zone. Host names below are relative to that zone; use DNS-only records. The new return-path records belong to `send.notify`, not the company's root mail domain. Preserve existing website and mailbox records. If a TXT SPF record already exists at the same host, merge its mechanisms into one SPF record rather than creating a second one.

| Type | Host | Value | Priority | TTL |
| --- | --- | --- | --- | --- |
| TXT | `resend._domainkey.notify` | See the complete DKIM value below | — | Auto/default |
| MX | `send.notify` | `feedback-smtp.us-east-1.amazonses.com` | 10 | Auto/default |
| TXT | `send.notify` | `v=spf1 include:amazonses.com ~all` | — | Auto/default |
| CNAME | `rsend.notify` | `send.forge.rmta.net` | — | Auto/default |

Complete DKIM TXT value, supplied by Resend:

```text
p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC9XzyxeFrl2uKRh9bEFB5kw+s7YrSaYdFPVX4aJcZrIrp1dLjl1yI8xDyEBdFXGIAXMqhKFD9nHTHP9EyVPclk2OsyaYDGQGZklXqNwdK5Q8qEJrBmgGnMM3K/TQp+4jnT+s6G8Qk9laWo1SmeQ1vNytNQgMhxMza47zQktPtUzwIDAQAB
```

The DKIM value is a public DNS verification key, not an API credential.

## Activation

After the records resolve, verify `notify.walshken.com` in Resend. Create a sending-only API key restricted to this domain, then save that protected key and an address such as `staff@notify.walshken.com` in the Staff Portal's Super Admin integration settings. The example is a sending identity; it does not create a receiving mailbox.

The deployment's staff-email origin must be `https://www.walshken.com`. The application never puts its API key, session token, payroll values, or private notification body in an email. A recipient follows the secure portal link and signs in to view the notification.

Each employee must enable email notifications themselves. Opting out cancels pending delivery for that employee. Disabled, suspended, or ended accounts must not receive queued notifications. Provider acceptance and inbox delivery are separate states; a successful API response does not establish inbox receipt.

## Release limitation

DNS verification, a protected sending key, and a real authorized delivery/receipt check are still required before describing staff email as operational. The existing in-app notification workflow is independent of those steps. No paid subscription was purchased and no recipient was enrolled automatically.
