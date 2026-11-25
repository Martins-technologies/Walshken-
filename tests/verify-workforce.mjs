import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/workspace/[...parts]/route.ts";
import { createHmac, randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "walshken-route-test-"));
mkdirSync(join(sandbox,"drizzle"));
for(const name of readdirSync(join(process.cwd(),"drizzle")))if(name.endsWith(".sql"))copyFileSync(join(process.cwd(),"drizzle",name),join(sandbox,"drizzle",name));
copyFileSync(join(process.cwd(),"supabase/migrations/20261122145905_staff_document_security.sql"),join(sandbox,"drizzle/0010_documents.sql"));
copyFileSync(join(process.cwd(),"supabase/migrations/20261122192455_employee_task_workflow.sql"),join(sandbox,"drizzle/0011_tasks.sql"));
copyFileSync(join(process.cwd(),"supabase/migrations/20261122203136_employee_attendance_shifts_timesheets.sql"),join(sandbox,"drizzle/0012_workforce.sql"));
writeFileSync(join(sandbox,"drizzle/00000_test_roles.sql"),"CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE walshken_production_app;");
const repository=process.cwd();
process.chdir(sandbox);
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));
process.env.WALSHKEN_ADMIN_EMAIL="admin@walshken.test";
process.env.WALSHKEN_SETUP_CODE=randomBytes(27).toString("base64url");
process.env.WALSHKEN_INTEGRATION_KEY=randomBytes(32).toString("base64");
process.env.WALSHKEN_REQUIRE_STAFF_MFA="1";
const origin = "https://test.walshken.test";
const secret = () => randomBytes(20).toString("base64url");
const runId = randomBytes(6).toString("hex");
const admin = { password: secret(), email: process.env.WALSHKEN_ADMIN_EMAIL, cookie: "" };
const coworker = { password: secret(), email: `coworker-${runId}@walshken.test`, cookie: "" };
const staff = { password: secret(), email: `staff-${runId}@walshken.test`, cookie: "" };

async function request(path, expected, user = null, body) {
  const incoming = new Request(origin + "/api/workspace/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, ...(user?.cookie ? { cookie: user.cookie } : {}),
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const context = { params: Promise.resolve({ parts: path.split("?")[0].split("/") }) };
  const response = await (body === undefined ? GET : POST)(incoming, context);
  const contentType = response.headers.get("content-type") ?? "";
  const result = contentType.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, expected, `${path} expected ${expected}, got ${response.status} — ${result?.error ?? ""}`);
  const cookie = response.headers.get("set-cookie");
  if (user && cookie) user.cookie = cookie.split(";")[0];
  return result;
}

function authenticatorCode(key, offset) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of key) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const hash = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const RealDate=globalThis.Date;
let offset=0;let fixedTime=null;
class TestDate extends RealDate {
  constructor(...args){super(...(args.length?args:[TestDate.now()]));}
  static now(){return fixedTime??RealDate.now()+offset;}
}
globalThis.Date=TestDate;
async function enroll(account) {
  // Password hashing may cross a TOTP window. Pin only this enrollment exchange.
  const previousTime=fixedTime;
  fixedTime=Date.now();
  try {
    const setup=await request("mfa/setup", 200, account, {password:account.password});
    const first=authenticatorCode(setup.setupKey,-1);
    const confirmed=await request("mfa/confirm", 200, account, {password:account.password,code:first});
    assert.equal(confirmed.recoveryCodes.length,8);
    await request("view/profile",401,account);
    const mfaCode=authenticatorCode(setup.setupKey,0);
    await request("session/login",200,account,{email:account.email,password:account.password,mfaCode});
    return {...confirmed,mfaCode};
  } finally { fixedTime=previousTime; }
}

admin.email=process.env.WALSHKEN_ADMIN_EMAIL;
await request("view/profile",401);
await request("session/bootstrap",200,admin,{email:admin.email,password:admin.password,name:"Part B QA Admin",code:process.env.WALSHKEN_SETUP_CODE});
assert.deepEqual(await request("view/profile",200,admin),{mfaRequired:true,enrollmentOnly:true});
await request("view/employees",403,admin);
await request("organization/add",403,admin,{kind:"Department",name:"QA Department"});
const adminMfa=await enroll(admin);
await request("mfa/disable",409,admin,{password:admin.password});
await request("organization/add",201,admin,{kind:"Department",name:"QA Department"});
const { rows: units }=await request("view/departments",200,admin);
const department=units.find(row=>row.name==="QA Department").id;
const employee={email:staff.email,name:"Part B QA Staff",employeeNo:"QA-"+runId,role:"employee",country:"CA",
  jurisdiction:"CA-AB",timeZone:"America/Edmonton",employmentType:"Full-time",hireDate:"2024-01-02",
  contractStart:"2024-01-05",expectedHours:40,department,breakPolicy:"unpaid"};
const {code}=await request("employees/add",201,admin,employee);
assert.equal((await request("session/activate",200,staff,{email:staff.email,password:staff.password,code})).signInRequired,true);
await request("view/profile",401,staff);
const afterActivation=(await request("view/employees",200,admin)).rows.find(row=>row.email===staff.email);
assert.ok(afterActivation.activated_at);
assert.equal(afterActivation.first_login_at,null);
offset+=1000;
await request("session/login",200,staff,{email:staff.email,password:staff.password});
await request("view/dashboard",403,staff);
const {rows}=await request("view/employees",200,admin);
const staffId=rows.find(row=>row.email===staff.email).id;
const manager=rows.find(row=>row.email===admin.email).id;
await enroll(staff);

const {workspaceDatabase}=await import("../lib/walshken/database.ts");
const db=workspaceDatabase();
const employeeRecord=(await request("view/employees",200,admin)).rows.find(row=>row.email===staff.email);
const guest={email:"guest@walshken.test",password:secret(),cookie:""};
const guestRecord={...employee,name:"External Guest",email:guest.email,employeeNo:"QA-GUEST",role:"guest"};
const guestInvite=await request("employees/add",201,admin,guestRecord);
await request("session/activate",200,guest,{...guest,code:guestInvite.code});
await request("session/login",200,guest,guest);
await enroll(guest);
const guestId=(await request("view/employees",200,admin)).rows.find(row=>row.email===guest.email).id;
const adminId=(await request("view/employees",200,admin)).rows.find(row=>row.email===admin.email).id;
await db.prepare("UPDATE employees SET department_id=? WHERE id=?",[department,adminId]).run();

process.env.WALSHKEN_ATTENDANCE_ENABLED='1';process.env.WALSHKEN_WORK_DATASET='preview';process.env.WALSHKEN_RELEASE_SCOPE='staff-attendance';
const {readFileSync}=await import('node:fs');
const {GET:workGet,POST:workPost}=await import('../app/api/workforce/[action]/route.ts');
const {defaultPolicy,localInstant,localWall,dayAdd,validatePolicy,compliance,totals}=await import('../lib/walshken/attendance-rules.ts');
const base=dayAdd(new RealDate().toISOString().slice(0,10),3),tz='America/Edmonton';
const instant=(day,time)=>localInstant(day+'T'+time,tz);
async function time(day,time){fixedTime=Date.parse(instant(day,time));await db.prepare('UPDATE sessions SET expires_at=?',[new Date(Date.now()+12*3600000).toISOString()]).run();}
async function work(action,status,user=admin,body,query=''){
 const req=new Request(origin+'/api/workforce/'+action+query,{method:body===undefined?'GET':'POST',headers:{origin,...(user?.cookie?{cookie:user.cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const response=await(body===undefined?workGet:workPost)(req,{params:Promise.resolve({action})}),result=response.headers.get('Content-Type')?.includes('json')?await response.json():await response.text();assert.equal(response.status,status,`${action} expected ${status}, got ${response.status}: ${result?.error??result}`);return result;
}
const post=(action,input={},status=200,user=admin)=>work(action,status,user,input);
const query='?from='+dayAdd(base,-20)+'&to='+dayAdd(base,70);
const data=(user=admin,extra='')=>work('list',200,user,undefined,query+extra);
const sheet=async(id,user=staff)=>(await data(user)).sheets.find(s=>s.attendance_id===id);
async function active(user=staff){return (await data(user)).active;}
async function clockAction(action,input={},expected=200,user=staff){const a=await active(user);return post(action,{revision:a?.revision,...input},expected,user);}
async function reviewSheet(id,who=managerUser,extra={}){const s=await sheet(id);return post('timesheet-review',{id:s.id,revision:s.revision,decision:'Approved',...extra},200,who);}
async function person(role,name,employeeNo){const user={email:(employeeNo+'@walshken.test').toLowerCase(),password:secret(),cookie:''};const invite=await request('employees/add',201,admin,{...employee,name,email:user.email,employeeNo,role});await request('session/activate',200,user,{email:user.email,password:user.password,code:invite.code});await request('session/login',200,user,user);await enroll(user);user.id=(await request('view/employees',200,admin)).rows.find(r=>r.email===user.email).id;return user;}
const managerUser=await person('manager','Attendance manager','WF-M-'+runId),outsider=await person('employee','Other employee','WF-OUT-'+runId);const hrUser=await person('hr','Attendance HR','WF-HR-'+runId);
await db.prepare('UPDATE employees SET manager_id=? WHERE id=?',[managerUser.id,staffId]).run();await db.prepare("UPDATE employees SET jurisdiction='CA-AB',time_zone='America/Edmonton' WHERE id=?",[adminId]).run();
assert.equal((await db.prepare('SELECT count(*)::int AS n FROM attendance',[]).first()).n,0,'Authentication must not create attendance');
await work('list',401,null);await work('list',403,guest);await request('attendance/in',404,staff,{});await request('shifts/add',404,admin,{});
await post('shift-create',{},403,staff);await post('policy-save',{},403,managerUser);await post('manual-entry',{employee:staffId},403,staff);
const basePolicy=defaultPolicy();basePolicy.breaks.push({key:'paid-rest',label:'Paid rest',minutes:15,paid:true,afterMinutes:120});
await post('policy-save',{employee:staffId,revision:0,policy:basePolicy});await post('policy-save',{employee:staffId,revision:0,policy:basePolicy},409);
await post('policy-save',{employee:staffId,revision:1,policy:{...basePolicy,breaks:[{key:'bad',label:'Too short',minutes:15,paid:false,afterMinutes:300}]}},400);
const shiftInput={title:'Customer services',location:'Calgary office',timeZone:tz,startsLocal:base+'T09:00',endsLocal:base+'T17:00',employees:[staffId,outsider.id]};
const created=await post('shift-create',shiftInput,201);assert.equal(created.ids.length,2);assert.equal((await data(staff)).shifts.length,0);await post('shift-publish',{ids:created.ids});const s1=(await data(staff)).shifts.find(s=>s.employee_id===staffId);assert.ok(s1);assert.equal((await data(staff)).shifts.length,1);assert.equal((await data(managerUser,'&team=1')).shifts.length,1);
await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:base+'T16:00',endsLocal:base+'T20:00'},409);await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:base+'T00:00',endsLocal:base+'T13:00'},400);
assert.equal((await request('view/scheduling',200,managerUser)).managedWorkforce,true);assert.equal((await request('view/attendance',200,staff)).managedWorkforce,true);
console.log('PASS independent login/attendance, MFA/role guards, employee policy floors, scoped multi-employee draft and published shifts');

await time(base,'09:10');const a1=(await post('clock-in',{shift:s1.id},201,staff)).id;await post('clock-in',{shift:s1.id},409,staff);await post('break-start',{revision:999,kind:'lunch'},409,staff);
await time(base,'11:10');await clockAction('break-start',{kind:'paid-rest'});await clockAction('break-start',{kind:'lunch'},409);await clockAction('clock-out',{},409);await time(base,'11:25');await clockAction('break-end');await clockAction('break-end',{},409);
await time(base,'13:00');await clockAction('break-start',{kind:'lunch'});await time(base,'13:30');await clockAction('break-end');await time(base,'16:50');await clockAction('clock-out');
let record=(await data(staff)).rows.find(r=>r.id===a1);assert.ok(Math.abs(record.totals.gross-27600)<=1);assert.ok(Math.abs(record.totals.unpaid-1800)<=1);assert.ok(Math.abs(record.totals.paid-25800)<=2);assert.equal(record.lateMinutes,10);assert.equal(record.earlyMinutes,10);assert.equal(record.late,true);assert.equal(record.early,true);assert.deepEqual(record.issues,[]);assert.equal(await active(),null);
let ts=await sheet(a1);await post('timesheet-review',{id:ts.id,revision:ts.revision,decision:'Approved'},403,staff);await post('timesheet-submit',{id:ts.id,revision:ts.revision},200,staff);await reviewSheet(a1);assert.equal((await sheet(a1)).status,'Approved');
assert.equal((await data(outsider)).rows.length,0);await work('detail',404,outsider,undefined,'?id='+a1);
const saved=JSON.parse((await db.prepare('SELECT policy_snapshot FROM attendance WHERE id=?',[a1]).first()).policy_snapshot);const nextPolicy={...basePolicy,manualAllowed:true};await post('policy-save',{employee:staffId,revision:1,policy:nextPolicy});assert.equal(JSON.parse((await db.prepare('SELECT policy_snapshot FROM attendance WHERE id=?',[a1]).first()).policy_snapshot).manualAllowed,saved.manualAllowed);
const manualDay=dayAdd(base,-1),manual=(await post('manual-entry',{employee:staffId,startsAt:instant(manualDay,'09:00'),endsAt:instant(manualDay,'17:00'),note:'Work completed during offline access.',breaks:[{kind:'lunch',startsAt:instant(manualDay,'12:00'),endsAt:instant(manualDay,'12:30')}]},201,staff)).id;
assert.equal((await sheet(manual)).paid_seconds,27000,'Eight hours less thirty minutes is seven and a half hours');await reviewSheet(manual);
const restrictedDay=dayAdd(base,-2),restricted=(await post('manual-entry',{employee:staffId,startsAt:instant(restrictedDay,'09:00'),endsAt:instant(restrictedDay,'17:00'),note:'Required to remain available during lunch.',breaks:[{kind:'lunch',startsAt:instant(restrictedDay,'12:00'),endsAt:instant(restrictedDay,'12:30'),restricted:true}]},201,staff)).id;assert.equal((await sheet(restricted)).paid_seconds,28800);assert.equal((await sheet(restricted)).unpaid_seconds,0);await reviewSheet(restricted);
await post('manual-entry',{employee:staffId,startsAt:instant(manualDay,'10:00'),endsAt:instant(manualDay,'11:00'),note:'Overlapping time',breaks:[]},409,staff);
await post('manual-entry',{employee:staffId,startsAt:instant(dayAdd(base,-4),'09:00'),endsAt:instant(dayAdd(base,-4),'17:00'),note:'Invalid overlapping breaks',breaks:[{kind:'lunch',startsAt:instant(dayAdd(base,-4),'12:00'),endsAt:instant(dayAdd(base,-4),'12:30')},{kind:'paid-rest',startsAt:instant(dayAdd(base,-4),'12:15'),endsAt:instant(dayAdd(base,-4),'12:45')}]},400,staff);
console.log('PASS server clocks, multiple paid/unpaid breaks, restricted-break pay, exact duration, late/early indicators, manual authorization, overlap and policy snapshots');

await time(base,'17:10');record=(await data(staff)).rows.find(r=>r.id===a1);const proposal={id:a1,revision:record.revision,startsAt:instant(base,'09:00'),endsAt:instant(base,'17:00'),breaks:[{kind:'lunch',startsAt:instant(base,'12:00'),endsAt:instant(base,'12:30')}],note:'Correct actual arrival and departure from verified office records.'};
const correction=(await post('correction-request',proposal,201,staff)).id;assert.ok(Math.abs((await sheet(a1)).paid_seconds-25800)<=2);let c=(await data(staff)).corrections.find(c=>c.id===correction);
await post('correction-review',{id:c.id,revision:c.revision,decision:'Approved',note:'Reviewed'},403,managerUser);await post('correction-review',{id:c.id,revision:c.revision,decision:'Approved',note:'Verified against the office record.'});assert.equal((await sheet(a1)).paid_seconds,27000);assert.equal((await sheet(a1)).status,'Submitted');await reviewSheet(a1);await post('correction-review',{id:c.id,revision:c.revision,decision:'Approved',note:'Duplicate'},409);
const history=await work('detail',200,staff,undefined,'?id='+a1);const applied=history.events.find(e=>e.action==='Attendance correction applied');assert.ok(JSON.parse(applied.detail).before.breaks.length===2);assert.ok((await db.prepare('SELECT count(*)::int AS n FROM breaks WHERE attendance_id=? AND voided_at IS NOT NULL',[a1]).first()).n>=2);
const incidentDay=dayAdd(base,-3),incident=(await post('manual-entry',{employee:staffId,startsAt:instant(incidentDay,'09:00'),endsAt:instant(incidentDay,'17:00'),note:'Missed break must not become an invented unpaid deduction.',breaks:[]},201,staff)).id;ts=await sheet(incident);assert.equal(ts.paid_seconds,28800);assert.ok(JSON.parse(ts.compliance_issues).length);await post('timesheet-review',{id:ts.id,revision:ts.revision,decision:'Approved'},409,managerUser);await post('timesheet-review',{id:ts.id,revision:ts.revision,decision:'Approved',acknowledge:true,note:'Documented the missed rest incident and corrective action; approve actual work.'});assert.ok(JSON.parse((await sheet(incident)).compliance_issues).length);
console.log('PASS administrator correction approval, atomic recalculation/resubmission, independent review, preserved break versions and compliance incidents without wage deduction');

// Calendar recurrence keeps local clock time across DST, and invalid local times cannot be silently shifted.
assert.throws(()=>localInstant('2027-03-14T02:30','America/New_York'),/does not exist/);assert.equal(Date.parse(localInstant('2027-11-07T01:30','America/New_York','later'))-Date.parse(localInstant('2027-11-07T01:30','America/New_York','earlier')),3600000);
assert.equal(localInstant('2027-01-15T09:00',tz),'2027-01-15T15:00:00.000Z');assert.equal(localInstant('2027-07-15T09:00',tz),'2027-07-15T15:00:00.000Z');
const dst=await post('shift-create',{...shiftInput,employees:[outsider.id],timeZone:'America/New_York',startsLocal:'2027-03-07T09:00',endsLocal:'2027-03-07T17:00',recurring:true,until:'2027-03-21',everyWeeks:1,weekdays:[0]},201);const dstRows=(await db.prepare('SELECT starts_at FROM shifts WHERE series_id=(SELECT series_id FROM shifts WHERE id=?) ORDER BY starts_at',[dst.ids[0]]).all()).results;assert.equal(dstRows.length,3);assert.ok(dstRows.every(r=>localWall(r.starts_at,'America/New_York').endsWith('T09:00')));assert.equal(Date.parse(dstRows[1].starts_at)-Date.parse(dstRows[0].starts_at),167*3600000);
const recurStart=dayAdd(base,10),recurEnd=dayAdd(recurStart,14),recurring=await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:recurStart+'T09:00',endsLocal:recurStart+'T17:00',recurring:true,until:recurEnd,everyWeeks:1,weekdays:[1,2,3,4,5]},201);assert.ok(recurring.ids.length>=10);await post('shift-publish',{ids:recurring.ids});
const tooSoon=await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:dayAdd(base,1)+'T09:00',endsLocal:dayAdd(base,1)+'T17:00'},201);await post('shift-publish',{ids:tooSoon.ids});const soon=(await data(staff)).shifts.find(s=>s.id===tooSoon.ids[0]);await post('shift-cancel',{id:soon.id,revision:soon.revision,note:'Insufficient notice'},409);
const swapDay=dayAdd(base,6),swapOther=dayAdd(base,7),swapA=await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:swapDay+'T09:00',endsLocal:swapDay+'T17:00'},201),swapB=await post('shift-create',{...shiftInput,employees:[outsider.id],startsLocal:swapOther+'T09:00',endsLocal:swapOther+'T17:00'},201);await post('shift-publish',{ids:[...swapA.ids,...swapB.ids]});const swap=(await post('swap-request',{source:swapA.ids[0],target:swapB.ids[0],note:'Mutually requested work-day exchange.'},201,staff)).id;let swapRow=(await data(outsider)).swaps.find(s=>s.id===swap);assert.ok(swapRow);await post('swap-review',{id:swap,revision:swapRow.revision,decision:'Approved',note:'Not yet consented'},409);await post('swap-response',{id:swap,revision:swapRow.revision,accept:true},200,outsider);swapRow=(await data(staff)).swaps.find(s=>s.id===swap);await post('swap-review',{id:swap,revision:swapRow.revision,decision:'Approved',note:'Both employees agreed and rest requirements verified.'});assert.equal((await db.prepare('SELECT employee_id FROM shifts WHERE id=?',[swapB.ids[0]]).first()).employee_id,staffId);
console.log('PASS finite recurring calendars, DST gaps/folds, draft publication, upcoming-change notice, overlap/rest validation and two-employee consent plus swap approval');

const leaveDay=dayAdd(base,30);const sickShift=await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:leaveDay+'T09:00',endsLocal:leaveDay+'T17:00'},201);await post('shift-publish',{ids:sickShift.ids});const leaveId=(await post('leave-request',{category:'Sick leave',startsOn:leaveDay,endsOn:leaveDay,note:'Sick day'},201,staff)).id;let l=(await data(staff)).leave.find(l=>l.id===leaveId);await post('leave-review',{id:l.id,revision:l.revision,decision:'Approved',note:'Reviewed'},403,staff);await post('leave-review',{id:l.id,revision:l.revision,decision:'Approved',note:'Approved sick day'},200,managerUser);await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:leaveDay+'T09:00',endsLocal:leaveDay+'T17:00'},409);
const holidayDay=dayAdd(base,31);const holidayShift=await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:holidayDay+'T09:00',endsLocal:holidayDay+'T17:00'},201);await post('shift-publish',{ids:holidayShift.ids});await post('holiday-create',{name:'Verified company holiday',day:holidayDay,type:'Company'},201);await post('shift-create',{...shiftInput,employees:[staffId],startsLocal:holidayDay+'T09:00',endsLocal:holidayDay+'T17:00'},409);
await db.prepare('CREATE SCHEMA IF NOT EXISTS walshken_private',[]).run();const job=readFileSync(join(repository,'ops/attendance-preview-maintenance.sql'),'utf8');await db.prepare(job.slice(job.indexOf('CREATE OR REPLACE FUNCTION'),job.indexOf('REVOKE ALL ON FUNCTION')),[]).run();const maintain=async()=>(await db.prepare('SELECT walshken_private.attendance_review_maintenance() AS result',[]).first()).result;
await time(dayAdd(base,2),'12:00');const firstMaintenance=await maintain();assert.ok(firstMaintenance.absences>=2);assert.equal((await maintain()).absences,0);assert.ok((await data(staff)).absences.some(a=>a.status==='No show'));
const a2=(await post('clock-in',{note:'Actual unscheduled work recorded independently.'},201,staff)).id;await time(dayAdd(base,3),'05:00');assert.ok((await maintain()).alerts>=2);assert.equal((await maintain()).alerts,0);assert.equal((await active()).ends_at,null);record=(await data(staff)).rows.find(r=>r.id===a2);assert.equal(record.missedClockOut,true);const missed=(await post('correction-request',{id:a2,revision:record.revision,startsAt:instant(dayAdd(base,2),'12:00'),endsAt:instant(dayAdd(base,2),'17:00'),breaks:[],note:'Forgot to clock out. Actual work ended at 5 pm.'},201,staff)).id;c=(await data(staff)).corrections.find(c=>c.id===missed);await post('correction-review',{id:c.id,revision:c.revision,decision:'Approved',note:'Verified actual finish time.'});assert.equal(await active(),null);await reviewSheet(a2);
console.log('PASS approved leave/sickness/holiday schedule checks, durable absence records, deduplicated missed-clock-out notifications and approved clock-out recovery');

// Overnight reports clip breaks correctly at employee-local midnight; grouping and export do not mix in session timestamps.
const nightDay=dayAdd(base,-5),night=(await post('manual-entry',{employee:staffId,startsLocal:nightDay+'T22:00',endsLocal:dayAdd(nightDay,1)+'T06:00',note:'Overnight work.',breaks:[{kind:'lunch',startsLocal:dayAdd(nightDay,1)+'T02:00',endsLocal:dayAdd(nightDay,1)+'T02:30'}]},201,staff)).id;await reviewSheet(night);let report=(await data(staff)).report;assert.equal(report.rows.find(r=>r.period===nightDay).paid,7200);assert.equal(report.rows.find(r=>r.period===dayAdd(nightDay,1)).paid,19800);assert.ok((await data(staff,'&period=week')).report.rows.every(r=>new Date(r.period+'T12:00Z').getUTCDay()===1));assert.ok((await data(staff,'&period=month')).report.rows.every(r=>/^\d{4}-\d\d$/.test(r.period)));const csv=await work('export',200,staff,undefined,query);assert.ok(csv.includes('Approved hours'));assert.ok(csv.includes(employeeRecord.employee_no));
const sevenStart=dayAdd(base,40);const seven=await post('shift-create',{...shiftInput,employees:[outsider.id],startsLocal:sevenStart+'T09:00',endsLocal:sevenStart+'T21:00',recurring:true,until:dayAdd(sevenStart,6),everyWeeks:1,weekdays:[0,1,2,3,4,5,6]},201);await post('shift-publish',{ids:seven.ids},409);assert.equal((await db.prepare("SELECT count(*)::int AS n FROM shifts WHERE series_id=(SELECT series_id FROM shifts WHERE id=?) AND state='Published'",[seven.ids[0]]).first()).n,0);await post('shift-publish',{ids:seven.ids.slice(0,6)});
await time(dayAdd(base,32),'18:00');await maintain();assert.ok((await data(staff)).absences.some(a=>a.status==='Sick leave'));assert.ok((await data(staff)).absences.some(a=>a.status==='Holiday'));
await db.prepare('UPDATE employees SET manager_id=NULL WHERE id=?',[staffId]).run();assert.ok(!(await data(managerUser,'&team=1')).rows.some(r=>r.employee_id===staffId));await work('detail',404,managerUser,undefined,'?id='+a1);await db.prepare('UPDATE employees SET manager_id=? WHERE id=?',[managerUser.id,staffId]).run();
for(const statement of ["GRANT SELECT ON attendance,shifts,timesheets,notifications TO walshken_production_app","CREATE POLICY test_prod_work ON attendance FOR SELECT TO walshken_production_app USING(true)","CREATE POLICY test_prod_shift ON shifts FOR SELECT TO walshken_production_app USING(true)","CREATE POLICY test_prod_sheet ON timesheets FOR SELECT TO walshken_production_app USING(true)","CREATE POLICY test_prod_note ON notifications FOR SELECT TO walshken_production_app USING(true)"])await db.prepare(statement,[]).run();await db.prepare('SET ROLE walshken_production_app',[]).run();for(const table of ['attendance','shifts','timesheets'])assert.equal((await db.prepare('SELECT count(*)::int AS n FROM '+table,[]).first()).n,0);assert.equal((await db.prepare("SELECT count(*)::int AS n FROM notifications WHERE release_stage='preview'",[]).first()).n,0);await db.prepare('RESET ROLE',[]).run();
await db.prepare("UPDATE employees SET status='Suspended' WHERE id=?",[staffId]).run();await work('list',401,staff);const nightRecord=(await db.prepare('SELECT * FROM attendance WHERE id=?',[night]).first());const adminProposal=(await post('correction-request',{id:night,revision:nightRecord.revision,startsAt:nightRecord.starts_at,endsAt:nightRecord.ends_at,breaks:[{kind:'lunch',startsAt:instant(dayAdd(nightDay,1),'02:00'),endsAt:instant(dayAdd(nightDay,1),'02:30')}],note:'Proposed on behalf of a suspended employee; verify actual recorded work.'},201)).id;const adminCorrection=(await data(admin,'&team=1')).corrections.find(c=>c.id===adminProposal);await post('correction-review',{id:adminProposal,revision:adminCorrection.revision,decision:'Approved',note:'Same proposer cannot review'},403);await post('correction-review',{id:adminProposal,revision:adminCorrection.revision,decision:'Approved',note:'Independently verified historical work.'},200,hrUser);await db.prepare("UPDATE employees SET status='Active' WHERE id=?",[staffId]).run();process.env.WALSHKEN_ATTENDANCE_ENABLED='0';await work('list',404,admin);
console.log('PASS daily/weekly/monthly and overnight report calculations, CSV, current-manager revocation, suspension, feature gating and production data isolation');
console.log('PART F WORKFORCE TESTS PASSED');
globalThis.Date=RealDate;
process.exit(0);
