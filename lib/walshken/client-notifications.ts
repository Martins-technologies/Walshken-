import {createHash} from "node:crypto";
import {clientEmailOrigin,clientEmailSender,sendClientEmail} from "./client-email";
import {clientPortalEnabled} from "./client-feature";
import {all,fail,id,json,now,one,run,str,type Db} from "./server";

type NoticeType = "security"|"case"|"document"|"payment"|"invoice"|"agreement"|"call"|"announcement";
type Notice = {type: NoticeType; title: string; body: string; href: string; dedupeKey: string; email?: boolean; securityRecipient?: string};
type Mail = {id: string; customer_id: string; type: NoticeType; mail_to: string | null; attempts: number; lease_token: string; transport_digest: string | null};
const internalLink = /^\/customer(?:\/[a-z0-9_./-]*)?(?:\?[a-z0-9_~.%+&=-]+)?$/i;

export async function notifyClient(db: Db, customerId: string, notice: Notice) {
  if (!clientPortalEnabled()) return null;
  if (!internalLink.test(notice.href) || notice.href.includes("..") || notice.href.includes("//")) return fail(400, "Use a client portal notification link.");
  const recipient = notice.type === "security" ? notice.securityRecipient ?? null : null;
  const text = {
    title: str(notice.title, "notification title", 150), body: str(notice.body, "notification body", 600),
    dedupe: str(notice.dedupeKey, "notification reference", 220),
  };
  const stamp = now(), target = id();
  const item = await one<{id:string}>(db, `INSERT INTO client_notifications
    (id,customer_id,type,title,body,href,dedupe_key,created_at,delivery,available_at,mail_to)
    SELECT ?,c.id,?,?,?,?,?,?,
      CASE WHEN ?=1 AND c.email_verified_at IS NOT NULL AND c.suspended_at IS NULL
        AND (?='security' OR COALESCE(p.email,0)=1) THEN 'Queued' ELSE 'In portal' END,?,
      CASE WHEN ?='security' THEN COALESCE(?,c.email) END
    FROM customers c LEFT JOIN client_notification_preferences p ON p.customer_id=c.id WHERE c.id=?
    ON CONFLICT(customer_id,dedupe_key) DO NOTHING RETURNING id`,
    target, notice.type, text.title, text.body, notice.href, text.dedupe, stamp,
    notice.email===false?0:1, notice.type, stamp, notice.type, recipient, customerId);
  return item?.id ?? null;
}

export async function clientNotifications(db: Db, customerId: string) {
  const [notifications, count, preference] = await Promise.all([
    all(db, `SELECT id,type,title,body,href,created_at AS "createdAt",read_at AS "readAt",delivery FROM client_notifications
      WHERE customer_id=? ORDER BY created_at DESC,id DESC LIMIT 100`, customerId),
    one<{n:number}>(db, "SELECT COUNT(*)::int AS n FROM client_notifications WHERE customer_id=? AND read_at IS NULL", customerId),
    one<{email:number}>(db, "SELECT email FROM client_notification_preferences WHERE customer_id=?", customerId),
  ]);
  return json({notifications, unread: count?.n ?? 0, preferences: {email: preference?.email === 1}});
}

export async function readClientNotification(db: Db, customerId: string, data: Record<string,unknown>) {
  const stamp = now();
  if (data.all === true) {
    await run(db, "UPDATE client_notifications SET read_at=? WHERE customer_id=? AND read_at IS NULL", stamp, customerId);
  } else {
    const updated = await run(db, "UPDATE client_notifications SET read_at=COALESCE(read_at,?) WHERE customer_id=? AND id=?", stamp, customerId, str(data.id,"notification",80));
    if (!updated.count) return fail(404, "This notification is unavailable.");
  }
  return json({ok:true});
}

export async function setClientNotificationPreferences(db: Db, customerId: string, data: Record<string,unknown>) {
  if (typeof data.email !== "boolean") return fail(400, "Choose whether to get optional updates by email.");
  await db.transaction(async tx => {
    await run(tx, `INSERT INTO client_notification_preferences(customer_id,email,updated_at) VALUES(?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET email=excluded.email,updated_at=excluded.updated_at`, customerId, data.email?1:0, now());
    if (!data.email) await run(tx, `UPDATE client_notifications SET delivery='Suppressed',lease_token=NULL,lease_until=NULL
      WHERE customer_id=? AND type<>'security' AND delivery IN ('Queued','Processing','Retry')`, customerId);
  });
  return json({ok:true,message:"Notification preferences saved."});
}

export async function processClientNotificationEmails(db: Db, budget = 9_000) {
  const result = {processed: 0, accepted: 0, retry: 0, failed: 0};
  if (!clientPortalEnabled() || budget < 2_000) return result;
  const [sender, origin] = await Promise.all([clientEmailSender(db).catch(() => null), Promise.resolve(clientEmailOrigin())]);
  if (!sender || !origin) return result;
  const transport = createHash("sha256").update(sender.apiKey+"\n"+sender.from+"\n"+origin).digest("hex");
  const until = Date.now() + budget;
  for (let index = 0; index < 5 && Date.now() + 1_500 < until; index++) {
    const stamp = now(), lease = id();
    const job = await db.transaction(async tx => {
      const row = await one<{id:string}>(tx, `SELECT id FROM client_notifications
        WHERE (delivery IN ('Queued','Retry') AND available_at<=?) OR (delivery='Processing' AND lease_until<=?)
        ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, stamp, stamp);
      if (!row) return null;
      return one<Mail>(tx, `UPDATE client_notifications SET delivery='Processing',lease_token=?,lease_until=?
        WHERE id=? RETURNING id,customer_id,type,mail_to,attempts,lease_token,transport_digest`, lease, new Date(Date.now()+60_000).toISOString(),row.id);
    });
    if (!job) break;
    result.processed++;
    const customer = await one<{email:string;email_verified_at:string|null;suspended_at:string|null;opted_in:number|null}>(db, `SELECT c.email,c.email_verified_at,c.suspended_at,p.email AS opted_in
      FROM customers c LEFT JOIN client_notification_preferences p ON p.customer_id=c.id WHERE c.id=?`, job.customer_id);
    const finish = (delivery:string,receipt:string|null=null,availableAt=stamp) => run(db,`UPDATE client_notifications
      SET delivery=?,provider_receipt=?,available_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND delivery='Processing'`,
      delivery,receipt,availableAt,job.id,job.lease_token);
    if (!customer?.email_verified_at || customer.suspended_at || job.type!=="security" && customer.opted_in!==1) {
      await finish("Suppressed");
      continue;
    }
    if (job.attempts>=5 || job.transport_digest && job.transport_digest!==transport) {
      await finish("Failed");
      result.failed++;
      continue;
    }
    const to = job.mail_to ?? customer.email;
    const delivery = await run(db,`UPDATE client_notifications SET attempts=attempts+1,mail_to=?,transport_digest=?
      WHERE id=? AND lease_token=? AND delivery='Processing'`, to,transport,job.id,job.lease_token);
    if (!delivery.count) continue;
    const security = job.type==="security";
    const subject = security ? "Walshken account security alert" : "New update in your Walshken client portal";
    const path = security ? "/customer/security" : "/customer/notifications";
    const content = security ? "An account security event occurred. Review it in your client portal."
      : "You have a new update. Sign in to your client portal to view it.";
    const sent = await sendClientEmail(sender,to,{subject,text:`${content}\n\n${origin}${path}`},`walshken-client-notice/${job.id}`);
    if (sent.receipt) {await finish("Accepted",sent.receipt);result.accepted++;}
    else if (sent.retryable && job.attempts<4) {
      await finish("Retry",null,new Date(Date.now()+60_000*2**job.attempts).toISOString());
      result.retry++;
    } else {await finish("Failed");result.failed++;}
  }
  return result;
}
