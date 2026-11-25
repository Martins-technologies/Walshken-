import { createHash, randomUUID } from "node:crypto";
import { all, audit, decryptSettings, encryptSettings, fail, integer, json, now, one, orgId, run, type Actor, type Db } from "./server";
import { validateEmailSettings } from "./staff-delivery";

export const notificationEmailEnabled = () => process.env.WALSHKEN_NOTIFICATION_EMAIL_ENABLED === "1";
type Preference = { enabled: number; revision: number };
type Delivery = { id: string; employee_id: string; status: string; attempts: number; created_at: string; first_attempt_at: string | null; encrypted_payload: string | null; transport_key_hash: string | null; lease_token: string };
type Recipient = { email: string; status: string; employment_status: string; enabled: number; read_at: string | null };
type EmailPayload = { from: string; to: string; subject: string; text: string };
const maxAttempts = 6;
const retryWindowMs = 23 * 3_600_000;

export async function notificationEmailData(db: Db, actor: Actor) {
  if (!notificationEmailEnabled()) return null;
  const [preference, provider, deliveries] = await Promise.all([
    one<Preference>(db, "SELECT enabled,revision FROM notification_email_preferences WHERE employee_id=? AND org_id=?", actor.id, actor.org_id),
    one(db, "SELECT id FROM integrations WHERE id='resend' AND enabled=1"),
    all(db, "SELECT id,status,attempts,created_at,sent_at,error_code FROM notification_email_outbox WHERE employee_id=? AND org_id=? ORDER BY created_at DESC,id DESC LIMIT 20", actor.id, actor.org_id),
  ]);
  return { enabled: preference?.enabled === 1, revision: preference?.revision ?? 0, providerConfigured: Boolean(provider), deliveries };
}

export async function saveNotificationEmailPreference(db: Db, actor: Actor, data: Record<string, unknown>) {
  if (!notificationEmailEnabled()) return fail(404, "Email notification preferences are unavailable.");
  if (typeof data.enabled !== "boolean") return fail(400, "Choose whether to receive email notifications.");
  if ((data.employee != null && data.employee !== actor.id) || (data.employeeId != null && data.employeeId !== actor.id)) return fail(403, "You can change only your own notification preferences.");
  const enabled = data.enabled ? 1 : 0;
  const revision = integer(data.revision, "preference revision", 0, 1_000_000_000);
  await db.transaction(async tx => {
    const employee = await one(tx, "SELECT id FROM employees WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended' FOR UPDATE", actor.id, actor.org_id);
    if (!employee) return fail(403, "This account cannot change notification preferences.");
    const current = await one<Preference>(tx, "SELECT enabled,revision FROM notification_email_preferences WHERE employee_id=? AND org_id=?", actor.id, actor.org_id);
    if ((current?.revision ?? 0) !== revision) return fail(409, "Your notification preferences changed. Refresh and try again.");
    await run(tx, `INSERT INTO notification_email_preferences(employee_id,org_id,enabled,revision,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(employee_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at`, actor.id, actor.org_id, enabled, revision + 1, now());
    if (!enabled) await run(tx, "UPDATE notification_email_outbox SET status='Skipped',error_code='opted_out',updated_at=?,encrypted_payload=NULL WHERE employee_id=? AND org_id=? AND status IN ('Pending','Retry')", now(), actor.id, actor.org_id);
    await audit(tx, actor, enabled ? "Workflow email notifications enabled by recipient" : "Workflow email notifications disabled by recipient", "notification preference", actor.id).run();
  });
  return json({ ok: true, message: enabled ? "Email notifications enabled for new updates. Existing notifications will not be emailed." : "Email notifications disabled. In-app updates remain available." });
}

function workflowPayload(from: string, to: string): EmailPayload {
  let origin: URL;
  try { origin = new URL(process.env.WALSHKEN_STAFF_EMAIL_ORIGIN || process.env.WALSHKEN_SITE_URL || "https://www.walshken.com"); }
  catch { return fail(503, "The notification link is awaiting configuration."); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return fail(503, "The notification link is awaiting configuration.");
  return { from, to, subject: "New Walshken workspace notification", text: `You have a new update in your Walshken staff workspace.\n\nSign in to read it: ${new URL("/staff/notifications", origin).href}\n\nEmail notifications are enabled in your personal notification preferences. You can turn them off on the same page. Sensitive message, payroll, document and employee details are available only after sign-in.` };
}

async function claim(db: Db): Promise<Delivery | null> {
  return db.transaction(async tx => {
    const time = now();
    const delivery = await one<Delivery>(tx, `SELECT id,employee_id,status,attempts,created_at,first_attempt_at,encrypted_payload,transport_key_hash,lease_token FROM notification_email_outbox
      WHERE org_id=? AND ((status IN ('Pending','Retry') AND available_at<=?) OR (status='Processing' AND lease_until<=?))
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, orgId, time, time);
    if (!delivery) return null;
    const lease = randomUUID();
    await run(tx, "UPDATE notification_email_outbox SET status='Processing',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND org_id=?", lease, new Date(Date.now() + 60_000).toISOString(), time, delivery.id, orgId);
    return { ...delivery, lease_token: lease };
  });
}

async function finish(db: Db, delivery: Delivery, status: string, error: string | null, providerId: string | null = null, retryAt: string | null = null) {
  await run(db, `UPDATE notification_email_outbox SET status=?,error_code=?,provider_id=COALESCE(?,provider_id),available_at=COALESCE(?,available_at),
    sent_at=?,updated_at=?,lease_token=NULL,lease_until=NULL,encrypted_payload=CASE WHEN ?='Retry' THEN encrypted_payload ELSE NULL END
    WHERE id=? AND org_id=? AND status='Processing' AND lease_token=?`, status, error, providerId, retryAt, status === "Sent" ? now() : null, now(), status, delivery.id, orgId, delivery.lease_token);
}

/** Bounded worker: no network calls unless a new notification was explicitly opted into. */
export async function processNotificationEmails(db: Db, budgetMs = 12_000) {
  const result = { enabled: notificationEmailEnabled(), provider: "disconnected", processed: 0, sent: 0, retry: 0, skipped: 0, failed: 0 };
  if (!result.enabled || budgetMs < 1_000) return result;
  const deadline = Date.now() + Math.min(budgetMs, 20_000);
  const integration = await one<{ configuration: string }>(db, "SELECT configuration FROM integrations WHERE id='resend' AND enabled=1");
  if (!integration) return result;
  let settings: { apiKey: string; from: string };
  try {
    settings = await decryptSettings("resend", integration.configuration) as typeof settings;
    validateEmailSettings(settings);
    workflowPayload(settings.from, "pending@example.invalid");
  } catch { result.provider = "configuration_error"; return result; }
  result.provider = "configured";
  const transportKeyHash = createHash("sha256").update(settings.apiKey).digest("hex");

  for (let index = 0; index < 3 && Date.now() < deadline - 1_000; index++) {
    const delivery = await claim(db);
    if (!delivery) break;
    result.processed++;
    const recipient = await one<Recipient>(db, `SELECT e.email,e.status,e.employment_status,p.enabled,n.read_at FROM notification_email_outbox o
      JOIN employees e ON e.id=o.employee_id AND e.org_id=o.org_id
      JOIN notifications n ON n.id=o.notification_id AND n.employee_id=e.id
      LEFT JOIN notification_email_preferences p ON p.employee_id=e.id AND p.org_id=e.org_id
      WHERE o.id=? AND o.org_id=?`, delivery.id, orgId);
    const skip = !recipient || recipient.status !== "Active" || recipient.employment_status === "Ended" ? "account_unavailable"
      : recipient.enabled !== 1 ? "opted_out" : recipient.read_at ? "already_read"
      : Date.now() - Date.parse(delivery.created_at) >= 24 * 3_600_000 ? "notification_expired" : null;
    if (skip) { await finish(db, delivery, "Skipped", skip); result.skipped++; continue; }
    if (delivery.attempts >= maxAttempts || (delivery.first_attempt_at && Date.now() - Date.parse(delivery.first_attempt_at) >= retryWindowMs)) {
      await finish(db, delivery, "Failed", "retry_limit"); result.failed++; continue;
    }
    if (delivery.encrypted_payload && delivery.transport_key_hash !== transportKeyHash) {
      // Provider idempotency is account-scoped. Never replay an uncertain send with a different credential.
      await finish(db, delivery, "Failed", "provider_changed"); result.failed++; continue;
    }
    let payload: EmailPayload;
    try {
      payload = delivery.encrypted_payload ? await decryptSettings(`workflow-email/${delivery.id}`, delivery.encrypted_payload) as EmailPayload : workflowPayload(settings.from, recipient!.email);
      if (payload.to !== recipient!.email) { await finish(db, delivery, "Skipped", "recipient_changed"); result.skipped++; continue; }
      const encrypted = delivery.encrypted_payload ?? await encryptSettings(`workflow-email/${delivery.id}`, payload);
      const stored = await run(db, "UPDATE notification_email_outbox SET encrypted_payload=?,transport_key_hash=?,first_attempt_at=COALESCE(first_attempt_at,?),attempts=attempts+1,updated_at=? WHERE id=? AND org_id=? AND status='Processing' AND lease_token=?", encrypted, transportKeyHash, now(), now(), delivery.id, orgId, delivery.lease_token);
      if (stored.count !== 1) continue;
    } catch { await finish(db, delivery, "Failed", "payload_unavailable"); result.failed++; continue; }
    // Recheck consent/account immediately before transport. A request already sent cannot be recalled.
    const allowed = await one(db, `SELECT e.id FROM employees e JOIN notification_email_preferences p ON p.employee_id=e.id AND p.org_id=e.org_id
      JOIN notification_email_outbox o ON o.employee_id=e.id AND o.org_id=e.org_id
      JOIN integrations i ON i.id='resend' AND i.enabled=1
      WHERE e.id=? AND e.org_id=? AND e.status='Active' AND e.employment_status<>'Ended' AND e.email=? AND p.enabled=1
      AND o.id=? AND o.status='Processing' AND o.lease_token=? AND o.lease_until>?`, delivery.employee_id, orgId, payload.to, delivery.id, delivery.lease_token, now());
    if (!allowed) { await finish(db, delivery, "Skipped", "consent_or_account_changed"); result.skipped++; continue; }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `workflow-notification/${orgId}/${delivery.id}` },
      body: JSON.stringify({ ...payload, to: [payload.to] }), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, deadline - Date.now()))),
    }).catch(() => null);
    const accepted = response?.ok ? await response.json().catch(() => null) : null;
    if (response?.ok && typeof accepted?.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(accepted.id)) {
      await finish(db, delivery, "Sent", null, accepted.id); result.sent++; continue;
    }
    const retryable = !response || response.ok || response.status === 429 || response.status === 409 || response.status >= 500;
    if (retryable && delivery.attempts + 1 < maxAttempts) {
      const retryAfter = Number(response?.headers.get("retry-after"));
      const delay = Math.min(3_600_000, Math.max(60_000 * 2 ** delivery.attempts, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 0));
      await finish(db, delivery, "Retry", response ? `provider_${response.status}` : "transport_unavailable", null, new Date(Date.now() + delay).toISOString());
      result.retry++;
    } else {
      await finish(db, delivery, "Failed", response ? `provider_${response.status}` : "retry_limit"); result.failed++;
    }
  }
  return result;
}
