import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/client-appointments/[audience]/route.ts";
import { maintainClientAppointmentReminders } from "../lib/walshken/client-appointments.ts";
import { scheduledMeetingTime } from "../lib/walshken/meeting-invitations.ts";
import { database, digest, now, one, all, run } from "../lib/walshken/server.ts";
import { guardClientAppointmentsForStaff } from "../lib/walshken/client-appointment-conflicts.ts";

const source=process.cwd(), sandbox=mkdtempSync(join(tmpdir(),"walshken-client-appointments-")), migrations=join(sandbox,"supabase","migrations");
mkdirSync(migrations,{recursive:true});
symlinkSync(join(source,"drizzle"),join(sandbox,"drizzle"),"dir");
for(const file of ["20261122145905_staff_document_security.sql","20261122192455_employee_task_workflow.sql","20261125231710_staff_unit_memberships.sql","20261127090000_client_identity.sql","20261127090200_client_cases.sql",
  "20261127090700_client_calls.sql","20261128102000_client_appointments.sql","20261128105000_client_preferences_and_mfa.sql"]) {
  copyFileSync(join(source,"supabase","migrations",file),join(migrations,file));
}
process.chdir(sandbox);
process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
delete process.env.DATABASE_URL;
delete process.env.WALSHKEN_SERVER_INTEGRATIONS;
process.env.NODE_ENV="test";
process.env.WALSHKEN_CLIENT_PORTAL_ENABLED="1";
process.env.WALSHKEN_REQUIRE_STAFF_MFA="1";
process.env.WALSHKEN_TASK_DATASET="preview";
const origin="https://client-appointments.walshken.test";
const db=database();
await run(db,"INSERT INTO organizations(id,name,time_zone) VALUES('walshken','Walshken','UTC')");
const minute=60_000, relative=value=>new Date(Date.now()+value*minute).toISOString();

async function employee(name,role,confirmed=true) {
  const id=randomUUID(), token=randomUUID()+randomUUID();
  await run(db,`INSERT INTO employees(id,org_id,employee_no,name,email,role,phone) VALUES(?,'walshken',?,?,?,?,?)`,id,id,name,`${id}@private-staff.test`,role,"123-555-0110");
  await run(db,"INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,?,'fixture')",await digest(token),id,relative(100));
  if(confirmed)await run(db,"INSERT INTO staff_mfa(employee_id,secret,setup_expires_at,confirmed_at) VALUES(?,'fixture',?,?)",id,relative(1),now());
  return {id,cookie:`walshken_session=${token}`};
}

async function customer(name,verified=true) {
  const id=randomUUID(), token=randomBytes(32).toString("hex");
  await run(db,"INSERT INTO customers(id,name,email,password_hash,email_verified_at) VALUES(?,?,?,'fixture',?)",id,name,`${id}@client.test`,verified?now():null);
  await run(db,"INSERT INTO customer_sessions(id,customer_id,expires_at,session_ref,idle_expires_at,last_seen_at) VALUES(?,?,?,?,?,?)",
    await digest(token),id,relative(100),randomUUID(),relative(80),now());
  await run(db,"INSERT INTO client_notification_preferences(customer_id,email,updated_at) VALUES(?,1,?)",id,now());
  return {id,cookie:`walshken_customer=${token}`};
}

const [host,secondHost,outside,admin,noMfa,client,peer,unverified]=await Promise.all([
  employee("Private Host","employee"),employee("Second Host","employee"),employee("Outside staff","employee"),
  employee("Company Admin","super_admin"),employee("Staff without MFA","employee",false),
  customer("Client One"),customer("Client Two"),customer("Unverified Client",false),
]);
async function createCase(customer,assigned,number) {
  const id=randomUUID();
  await run(db,`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,assigned_employee_id,representative_name,representative_designation,created_at,updated_at)
    VALUES(?,'walshken',?,?,?,'consultation','CA',?,'Walshken Case Desk','Case representative',?,?)`,
    id,customer.id,number,`Case ${number}`,assigned.id,now(),now());
  return id;
}
const caseA=await createCase(client,host,"QAP-1"),caseB=await createCase(peer,host,"QAP-2");
const secondCaseA=await createCase(client,secondHost,"QAP-3");

async function request(audience,account,caseId,payload,extras="",site=origin) {
  const response=await (payload?POST:GET)(new Request(`${origin}/api/client-appointments/${audience}?case=${encodeURIComponent(caseId)}${extras}`,{
    method:payload?"POST":"GET",headers:{origin:site,...(account?{cookie:account.cookie}:{}),...(payload?{"content-type":"application/json"}:{})},
    body:payload?JSON.stringify({case:caseId,...payload}):undefined,
  }),{params:Promise.resolve({audience})});
  const raw=await response.text();
  assert.match(response.headers.get("cache-control"),/no-store/);
  if(audience==="client") assert.doesNotMatch(raw,/private-staff\.test|123-555-0110|Private Host|Second Host/i);
  return {status:response.status,body:response.headers.get("content-type")?.includes("application/json")?JSON.parse(raw):raw};
}
async function expect(audience,account,caseId,status,payload,extras,site) {
  const result=await request(audience,account,caseId,payload,extras,site);
  assert.equal(result.status,status,JSON.stringify(result.body));
  return result.body;
}
const at=(delta,mode="Video")=>({action:"publish",localStart:relative(delta).slice(0,16),timeZone:"UTC",duration:30,mode});

await expect("client",null,caseA,401);
await expect("client",unverified,caseA,403);
await expect("staff",noMfa,caseA,403);
await expect("staff",outside,caseA,404);
await expect("client",peer,caseA,404);
await expect("client",client,caseA,403,at(80));
await expect("staff",host,caseA,403,at(80),"","https://outside.test");
const slot1=(await expect("staff",admin,caseA,201,at(80))).id;
await expect("staff",host,caseA,409,at(85));
const slot2=(await expect("staff",host,caseA,201,at(140))).id;
const altSlot=(await expect("staff",secondHost,secondCaseA,201,at(140))).id;
assert.deepEqual((await expect("client",client,caseA,200)).slots.map(slot=>slot.id),[slot1,slot2]);
assert.deepEqual((await expect("client",client,secondCaseA,200)).slots.map(slot=>slot.id),[altSlot]);

const winners=await Promise.all([request("client",client,caseA,{action:"book",slot:slot1}),request("client",peer,caseB,{action:"book",slot:slot1})]);
assert.deepEqual(winners.map(result=>result.status).sort(),[201,409]);
const selected=winners.findIndex(result=>result.status===201);
const [owner,ownedCase,intruder,intruderCase]=selected===0?[client,caseA,peer,caseB]:[peer,caseB,client,caseA];
const winning=winners[selected].body.appointment;
assert.equal(typeof winning.id,"string");
assert.equal((await expect("client",owner,ownedCase,200,undefined,"&view=summary")).appointments[0].id,winning.id);
await expect("client",intruder,intruderCase,404,undefined,`&appointment=${winning.id}&view=calendar`);
const calendar=await expect("client",owner,ownedCase,200,undefined,`&appointment=${winning.id}&view=calendar`);
assert.match(calendar,/BEGIN:VCALENDAR\r\nVERSION:2.0[\s\S]*DTSTART:\d{8}T\d{6}Z/);
await expect("staff",host,ownedCase,409,{action:"withdraw",slot:slot1});
await expect("client",owner,ownedCase,409,{action:"join",appointment:winning.id});
const moved=(await expect("client",owner,ownedCase,200,{action:"reschedule",appointment:winning.id,revision:1,slot:slot2})).appointment;
assert.equal(moved.revision,2);
const ownerIsFirst=owner.id===client.id;
if(ownerIsFirst) await expect("client",client,secondCaseA,409,{action:"book",slot:altSlot});
else {
  // A customer with two cases cannot book two representatives at the same time.
  const extraCase=await createCase(peer,secondHost,"QAP-4");
  await expect("client",peer,extraCase,409,{action:"book",slot:altSlot});
}
await assert.rejects(()=>db.transaction(tx=>guardClientAppointmentsForStaff(tx,"walshken",[host.id],moved.startsAt,moved.endsAt)),/already has a client appointment/);
await expect("client",owner,ownedCase,409,{action:"cancel",appointment:winning.id,revision:1});
await expect("client",owner,ownedCase,200,{action:"cancel",appointment:winning.id,revision:2});
await db.transaction(tx=>guardClientAppointmentsForStaff(tx,"walshken",[host.id],moved.startsAt,moved.endsAt));
await expect("client",intruder,intruderCase,201,{action:"book",slot:slot1});
assert.ok((await expect("client",owner,ownedCase,200)).appointments.some(item=>item.status==="Cancelled"));
console.log("PASS authorized Staff and Super Admin publishing, booking collision across two cases and representatives, rescheduling, cancellation, stale version, private calendar and existing meeting conflict guard");

const blockedMeeting=randomUUID();
await run(db,`INSERT INTO meetings(id,org_id,organizer_id,title,starts_at,ends_at)
 VALUES(?,'walshken',?,'Internal planning',?,?)`,blockedMeeting,host.id,relative(230),relative(260));
await expect("staff",host,caseA,409,at(240));
const reminderSlot=(await expect("staff",host,caseA,201,at(45,"Audio"))).id;
const reminder=(await expect("client",client,caseA,201,{action:"book",slot:reminderSlot})).appointment;
assert.ok((await maintainClientAppointmentReminders(db,"walshken")).notificationsQueued>=1);
assert.equal((await maintainClientAppointmentReminders(db,"walshken")).notificationsQueued,0);
const notifications=await all(db,"SELECT type,delivery,title FROM client_notifications WHERE customer_id=? AND href LIKE ? ORDER BY title",client.id,`%appointment=${reminder.id}`);
assert.deepEqual(notifications.map(row=>row.delivery),["Queued","Queued"]);
assert.ok(notifications.every(row=>row.type==="appointment"));
assert.ok(notifications.some(row=>row.title==="Upcoming Walshken appointment"));
await run(db,"UPDATE client_appointments SET starts_at=?,ends_at=? WHERE id=?",relative(3),relative(33),reminder.id);
await expect("client",client,caseA,503,{action:"join",appointment:reminder.id});
process.env.WALSHKEN_SERVER_INTEGRATIONS=JSON.stringify({livekit:{
  url:"wss://walshken-appointment-fixture.livekit.cloud",apiKey:"local-fixture",apiSecret:randomBytes(32).toString("hex"),
}});
const opens=await expect("client",client,caseA,200,{action:"join",appointment:reminder.id});
assert.equal(opens.href,`/customer/contact?case=${caseA}`);
await expect("staff",admin,caseA,403,{action:"join",appointment:reminder.id});
const staffOpens=await expect("staff",host,caseA,200,{action:"join",appointment:reminder.id});
assert.equal(staffOpens.href,`/staff/client-casework?tab=communication&case=${caseA}`);
const rings=await all(db,"SELECT status,mode FROM client_calls WHERE case_id=? AND created_at>?",caseA,relative(-10));
assert.deepEqual(rings,[{status:"Ringing",mode:"Audio"}]);
await run(db,"UPDATE client_cases SET assigned_employee_id=? WHERE id=?",secondHost.id,caseA);
await expect("client",client,caseA,403,{action:"join",appointment:reminder.id});
await expect("staff",host,caseA,404);
await run(db,"UPDATE client_appointments SET starts_at=?,ends_at=? WHERE id=?",relative(-40),relative(-10),reminder.id);
await expect("client",client,caseA,403,{action:"complete",appointment:reminder.id,revision:1});
await expect("staff",admin,caseA,200,{action:"complete",appointment:reminder.id,revision:1});
assert.equal((await expect("client",client,caseA,200)).appointments.find(item=>item.id===reminder.id).status,"Completed");
assert.throws(()=>scheduledMeetingTime("2026-03-08T02:30","start","America/Toronto"),/may not exist/);
assert.throws(()=>scheduledMeetingTime("2026-11-01T01:30","start","America/Toronto"),/unambiguous/);
assert.equal(scheduledMeetingTime("2026-11-01T14:00","start","Asia/Karachi"),"2026-11-01T09:00:00.000Z");
console.log("PASS timezone transitions, internal meeting clash, deduplicated real outbox, scoped timed join using existing audio path, safe provider unavailable and reassignment");

await run(db,"CREATE ROLE appointment_scope");
await run(db,"GRANT SELECT ON client_cases,client_appointments,client_appointment_slots,client_appointment_events TO appointment_scope");
await run(db,"ALTER TABLE client_cases ENABLE ROW LEVEL SECURITY");
await run(db,"CREATE POLICY fixture_cases ON client_cases TO appointment_scope USING(true)");
await run(db,"CREATE POLICY fixture_appointments ON client_appointments TO appointment_scope USING(true)");
await run(db,"CREATE POLICY fixture_slots ON client_appointment_slots TO appointment_scope USING(true)");
await run(db,"CREATE POLICY fixture_events ON client_appointment_events TO appointment_scope USING(true)");
await db.transaction(async tx=>{
  await run(tx,"SET LOCAL ROLE appointment_scope");
  await run(tx,"SELECT set_config('walshken.client_customer_id',?,true)",peer.id);
  const rows=await all(tx,"SELECT customer_id FROM client_appointments");
  assert(rows.length>0);
  assert(rows.every(row=>row.customer_id===peer.id));
  assert.equal(await one(tx,"SELECT id FROM client_appointment_events WHERE appointment_id=?",reminder.id),null);
});
console.log("PASS database role policy denies other-client appointment and event access");
