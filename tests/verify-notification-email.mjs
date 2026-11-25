import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processNotificationEmails } from '../lib/walshken/notification-email.ts';
import { encryptSettings, notify } from '../lib/walshken/server.ts';

export async function verifyNotificationEmail({db,request,admin,staff,adminId,staffId}) {
 const sql=(statement,...args)=>db.prepare(statement,args);
 const current=id=>sql('SELECT * FROM notification_email_outbox WHERE id=?',id).first();
 const count=async()=>Number((await sql('SELECT count(*)::int AS n FROM notification_email_outbox').first()).n);
 const insert=async(employee=adminId,stage='production')=>{
  const id=randomUUID();
  await sql('INSERT INTO notifications(id,employee_id,title,body,href,release_stage) VALUES(?,?,?,?,?,?)',id,employee,'PRIVATE salary approval','SENSITIVE-PAYROLL-123456','https://untrusted.example/private',stage).run();
  return id;
 };
 const prefs=async(user=admin)=>(await request('view/notifications',200,user)).notificationEmail;
 const opt=async(enabled,user=admin)=>request('notifications/preferences',200,user,{enabled,revision:(await prefs(user)).revision});
 const due=id=>sql("UPDATE notification_email_outbox SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?",id).run();
 let key='re_ISOLATED_TEST_CREDENTIAL_12345';
 const configure=async(enabled=1)=>sql(`INSERT INTO integrations(id,configuration,enabled) VALUES('resend',?,?) ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,enabled=excluded.enabled`,await encryptSettings('resend',{apiKey:key,from:'verified@walshken.test'}),enabled).run();
 let responses=[],sends=[];
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://api.resend.com/emails','Only the mocked Resend transport may be called');
  const body=JSON.parse(options.body),headers=new Headers(options.headers);
  sends.push({body,key:headers.get('idempotency-key')});
  assert.deepEqual(body.to,[body.to[0]]);
  assert.equal(body.subject,'New Walshken workspace notification');
  assert.match(body.text,/\/staff\/notifications/);
  assert.ok(!JSON.stringify(body).includes('SENSITIVE-PAYROLL'));
  assert.ok(!JSON.stringify(body).includes('PRIVATE salary'));
  assert.ok(!JSON.stringify(body).includes('untrusted.example'));
  assert.equal(options.redirect,'error');
  const next=responses.shift()??200;
  if(next==='timeout')throw new Error('Simulated uncertain provider acceptance');
  if(typeof next==='function')return next();
  return new Response(JSON.stringify(next===200?{id:randomUUID()}:{error:'SECRET_PROVIDER_ERROR_DO_NOT_RETURN'}),{status:next,headers:{'Content-Type':'application/json',...(next===429?{'Retry-After':'120'}:{})}});
 };
 try {
  await request('notifications/preferences',404,admin,{enabled:true,revision:0});
  assert.equal((await processNotificationEmails(db)).enabled,false);
  process.env.WALSHKEN_NOTIFICATION_EMAIL_ENABLED='1';
  process.env.WALSHKEN_SITE_URL='https://www.walshken.com';
  const initial=await prefs();assert.equal(initial.enabled,false);assert.equal(initial.revision,0);assert.equal(initial.providerConfigured,false);
  const old=await insert();assert.equal(await count(),0,'Default-off must not queue email');
  await request('notifications/preferences',401,null,{enabled:true,revision:0});
  await request('notifications/preferences',400,admin,{enabled:'yes',revision:0});
  await request('notifications/preferences',403,admin,{enabled:true,revision:0,employee:staffId});
  await opt(true);await request('notifications/preferences',409,admin,{enabled:false,revision:0});
  assert.equal(await current(old),null,'Opt-in cannot backfill old notifications');assert.equal((await prefs(staff)).enabled,false);
  const preview=await insert(adminId,'preview');assert.equal(await current(preview),null,'Preview notifications cannot enter the public production email queue');
  const first=await insert();assert.equal((await current(first)).status,'Pending');
  assert.equal((await processNotificationEmails(db)).provider,'disconnected');assert.equal(sends.length,0);assert.equal((await current(first)).attempts,0);
  await configure(0);assert.equal((await processNotificationEmails(db)).provider,'disconnected');assert.equal(sends.length,0);
  await configure();responses=[503];
  const retry=await processNotificationEmails(db);assert.equal(retry.retry,1);assert.equal(sends.length,1);
  let row=await current(first);assert.equal(row.status,'Retry');assert.equal(row.attempts,1);assert.ok(row.encrypted_payload);assert.ok(!row.encrypted_payload.includes(admin.email));assert.ok(!row.encrypted_payload.includes(key));
  assert.equal((await processNotificationEmails(db)).processed,0);assert.equal(sends.length,1,'Backoff must prevent immediate duplicate attempts');
  await due(first);const resent=await processNotificationEmails(db);assert.equal(resent.sent,1);assert.equal(sends.length,2);assert.equal(sends[0].key,sends[1].key);assert.deepEqual(sends[0].body,sends[1].body,'Retry body must be exactly stable');
  row=await current(first);assert.equal(row.status,'Sent');assert.equal(row.attempts,2);assert.equal(row.encrypted_payload,null);assert.ok(row.provider_id);
  await processNotificationEmails(db);assert.equal(sends.length,2,'A completed receipt must not resend');
  assert.equal((await prefs(staff)).deliveries.length,0,'Recipient cannot see another employee delivery activity');
  const visible=JSON.stringify(await prefs());for(const forbidden of [key,'encrypted_payload','transport_key_hash','SECRET_PROVIDER_ERROR'])assert.ok(!visible.includes(forbidden));
  console.log('PASS default-off consent, no backfill, provider-disabled handling, preview isolation, encrypted queue, bounded retry and exact idempotent payload');

  await notify(db,adminId,'Private workflow decision','Never emailed','/staff/payroll').run();
  const queued=(await sql("SELECT id FROM notification_email_outbox WHERE status='Pending'").first()).id;
  const before=sends.length;await Promise.all([processNotificationEmails(db),processNotificationEmails(db)]);assert.equal(sends.length,before+1);assert.equal((await current(queued)).status,'Sent','Concurrent workers claim each event once');
  const cancelled=await insert();await opt(false);assert.equal((await current(cancelled)).status,'Skipped');const afterOff=sends.length;await processNotificationEmails(db);assert.equal(sends.length,afterOff);
  const afterDisabled=await insert();assert.equal(await current(afterDisabled),null);await opt(true);assert.equal(await current(afterDisabled),null);
  const read=await insert();await sql('UPDATE notifications SET read_at=? WHERE id=?',new Date().toISOString(),read).run();await processNotificationEmails(db);assert.equal((await current(read)).error_code,'already_read');assert.equal(sends.length,afterOff);
  await opt(true,staff);const suspended=await insert(staffId);await sql("UPDATE employees SET status='Suspended' WHERE id=?",staffId).run();await processNotificationEmails(db);assert.equal((await current(suspended)).error_code,'account_unavailable');assert.equal(sends.length,afterOff);await sql("UPDATE employees SET status='Active' WHERE id=?",staffId).run();
  const ended=await insert(staffId);await sql("UPDATE employees SET employment_status='Ended' WHERE id=?",staffId).run();await processNotificationEmails(db);assert.equal((await current(ended)).error_code,'account_unavailable');await sql("UPDATE employees SET employment_status='Active' WHERE id=?",staffId).run();
  const stale=await insert();await sql("UPDATE notification_email_outbox SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?",stale).run();await processNotificationEmails(db);assert.equal((await current(stale)).error_code,'notification_expired');
  console.log('PASS helper/direct-insert capture, concurrent lease claims, opt-out cancellation, read notifications, suspended/ended exclusion and expired queue suppression');

  const permanent=await insert();responses=[422];await processNotificationEmails(db);assert.equal((await current(permanent)).status,'Failed');const permanentCount=sends.length;await processNotificationEmails(db);assert.equal(sends.length,permanentCount);
  const uncertainty=await insert();responses=['timeout'];await processNotificationEmails(db);assert.equal((await current(uncertainty)).status,'Retry');const uncertainRequest=sends.at(-1);await due(uncertainty);await processNotificationEmails(db);assert.equal((await current(uncertainty)).status,'Sent');assert.deepEqual(sends.at(-1),uncertainRequest);
  const limit=await insert();responses=[429];await processNotificationEmails(db);row=await current(limit);assert.equal(row.status,'Retry');assert.ok(Date.parse(row.available_at)-Date.now()>100_000,'Honor Retry-After');await sql('UPDATE notification_email_outbox SET attempts=6,available_at=? WHERE id=?','2000-01-01T00:00:00.000Z',limit).run();const beforeLimit=sends.length;await processNotificationEmails(db);assert.equal((await current(limit)).error_code,'retry_limit');assert.equal(sends.length,beforeLimit);
  const expired=await insert();responses=['timeout'];await processNotificationEmails(db);await sql('UPDATE notification_email_outbox SET first_attempt_at=?,available_at=? WHERE id=?',new Date(Date.now()-23.5*3600000).toISOString(),'2000-01-01T00:00:00.000Z',expired).run();const beforeExpiry=sends.length;await processNotificationEmails(db);assert.equal((await current(expired)).error_code,'retry_limit');assert.equal(sends.length,beforeExpiry,'Do not retry after the provider idempotency safety window');
  const addressChange=await insert(staffId);responses=['timeout'];await processNotificationEmails(db);await sql('UPDATE employees SET email=? WHERE id=?','changed-recipient@walshken.test',staffId).run();await due(addressChange);const beforeAddress=sends.length;await processNotificationEmails(db);assert.equal((await current(addressChange)).error_code,'recipient_changed');assert.equal(sends.length,beforeAddress);
  const keyChange=await insert();responses=['timeout'];await processNotificationEmails(db);key='re_DIFFERENT_PROVIDER_ACCOUNT_12345';await configure();await due(keyChange);const beforeKey=sends.length;await processNotificationEmails(db);assert.equal((await current(keyChange)).error_code,'provider_changed');assert.equal(sends.length,beforeKey,'Do not replay an uncertain send against a changed provider credential');
  console.log('PASS permanent errors, uncertain acceptance, rate-limit backoff, retry count/window caps, changed recipients and changed provider identity');

  // A lost worker may leave a lease; retries retain the first payload and key.
  const abandoned=await insert();responses=['timeout'];await processNotificationEmails(db);const lost=sends.at(-1);await sql("UPDATE notification_email_outbox SET status='Processing',lease_token='abandoned',lease_until='2000-01-01T00:00:00.000Z' WHERE id=?",abandoned).run();await processNotificationEmails(db);assert.equal((await current(abandoned)).status,'Sent');assert.deepEqual(sends.at(-1),lost);
  const disabled=await insert();delete process.env.WALSHKEN_NOTIFICATION_EMAIL_ENABLED;const beforeFlag=sends.length;await processNotificationEmails(db);assert.equal(sends.length,beforeFlag);assert.equal((await current(disabled)).status,'Pending');
  console.log('PASS expired lease recovery, durable receipts and deployment flag enforcement; all provider calls were mocked');
 } finally { globalThis.fetch=originalFetch; }
}
