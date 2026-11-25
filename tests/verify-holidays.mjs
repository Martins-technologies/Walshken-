import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {GET as PAYROLL_GET,POST as PAYROLL_POST} from '../app/api/payroll/[action]/route.ts';
import { GET, POST } from "../app/api/workspace/[...parts]/route.ts";
import { createHmac, randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "walshken-route-test-"));
mkdirSync(join(sandbox,"drizzle"));
for(const name of readdirSync(join(process.cwd(),"drizzle")))if(name.endsWith(".sql"))copyFileSync(join(process.cwd(),"drizzle",name),join(sandbox,"drizzle",name));
copyFileSync(join(process.cwd(),"supabase/migrations/20261122145905_staff_document_security.sql"),join(sandbox,"drizzle/0010_documents.sql"));
copyFileSync(join(process.cwd(),"supabase/migrations/20261122192455_employee_task_workflow.sql"),join(sandbox,"drizzle/0011_tasks.sql"));
copyFileSync(join(process.cwd(),"supabase/migrations/20261122203136_employee_attendance_shifts_timesheets.sql"),join(sandbox,"drizzle/0012_workforce.sql"));
writeFileSync(join(sandbox,"drizzle/00000_test_roles.sql"),"CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE walshken_production_app;");
copyFileSync(join(process.cwd(),'supabase/migrations/20261123114028_employee_salary_payroll.sql'),join(sandbox,'drizzle/0013_payroll.sql'));
mkdirSync(join(sandbox,'public'));copyFileSync(join(process.cwd(),'public/payroll-font.ttf'),join(sandbox,'public/payroll-font.ttf'));
const holidayMigration=readFileSync(join(process.cwd(),'supabase/migrations/20261123153905_canadian_holidays_compliance.sql'),'utf8'),holidaySeed=holidayMigration.slice(holidayMigration.indexOf('INSERT INTO holiday_rules'));writeFileSync(join(sandbox,'drizzle/0014_holidays.sql'),holidayMigration.slice(0,holidayMigration.indexOf('INSERT INTO holiday_rules')));
if(process.env.WALSHKEN_TEST_READINESS==="1") copyFileSync(join(process.cwd(),"supabase/migrations/20261124192707_staff_readiness.sql"),join(sandbox,"drizzle/0015_readiness.sql"));
if(process.env.WALSHKEN_TEST_EMPLOYMENT==="1") copyFileSync(join(process.cwd(),"supabase/migrations/20261124211828_dynamic_employment_engine.sql"),join(sandbox,"drizzle/0016_employment.sql"));
if(process.env.WALSHKEN_TEST_ENTERPRISE==="1") copyFileSync(join(process.cwd(),"supabase/migrations/20261124223624_enterprise_payroll_privacy_workflows.sql"),join(sandbox,"drizzle/0017_enterprise.sql"));
if(process.env.WALSHKEN_TEST_SOURCE==="1") copyFileSync(join(process.cwd(),"supabase/migrations/20261123220736_messaging_document_references.sql"),join(sandbox,"drizzle/0014a_message_documents.sql"));
if(process.env.WALSHKEN_TEST_SOURCE==="1") copyFileSync(join(process.cwd(),"supabase/migrations/20261125053842_source_disposal_employer_validation.sql"),join(sandbox,"drizzle/0018_source_disposal.sql"));
if(process.env.WALSHKEN_TEST_FINAL_OPS==="1") copyFileSync(join(process.cwd(),"supabase/migrations/20261125093948_project_lifecycle_and_workforce_reporting.sql"),join(sandbox,"drizzle/0019_operations.sql"));
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
  const incoming = new Request(origin + (path.startsWith("payroll/")?"/api/":"/api/workspace/") + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, ...(user?.cookie ? { cookie: user.cookie } : {}),
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const context = { params: Promise.resolve({ parts: path.split("?")[0].split("/") }) };
  const response = path.startsWith("payroll/")?await (body===undefined?PAYROLL_GET:PAYROLL_POST)(incoming,{params:Promise.resolve({action:path.split("/")[1]})}):await (body === undefined ? GET : POST)(incoming, context);
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

for(const sql of holidaySeed.split('\n').filter(s=>s.startsWith('INSERT INTO holiday_rules')))await db.prepare(sql,[]).run();
process.env.WALSHKEN_ATTENDANCE_ENABLED='1';process.env.WALSHKEN_WORK_DATASET='preview';process.env.WALSHKEN_PAYROLL_ENABLED='1';process.env.WALSHKEN_PAYROLL_DATASET='preview';process.env.WALSHKEN_HOLIDAYS_ENABLED='1';process.env.WALSHKEN_HOLIDAY_DATASET='preview';process.env.WALSHKEN_RELEASE_SCOPE='staff-holidays';
const routes={holidays:await import('../app/api/holidays/[action]/route.ts'),payroll:await import('../app/api/payroll/[action]/route.ts'),workforce:await import('../app/api/workforce/[action]/route.ts')};
const {canadianCalendars,holidayDates}=await import('../lib/walshken/canadian-calendars.ts');
const {defaultPayPolicy}=await import('../lib/walshken/payroll-access.ts'),{zeroBalance}=await import('../lib/walshken/payroll-money.ts'),{defaultPolicy,localInstant,dayAdd}=await import('../lib/walshken/attendance-rules.ts');
async function endpoint(kind,action,status=200,user=admin,body,query=''){
 const req=new Request(origin+'/api/'+kind+'/'+action+query,{method:body===undefined?'GET':'POST',headers:{origin,...(user?.cookie?{cookie:user.cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),res=await routes[kind][body===undefined?'GET':'POST'](req,{params:Promise.resolve({action})}),ct=res.headers.get('Content-Type')??'',v=ct.includes('json')?await res.json():ct.includes('pdf')?Buffer.from(await res.arrayBuffer()):await res.text();assert.equal(res.status,status,`${kind}/${action}: expected ${status} got ${res.status}: ${v?.error??String(v).slice(0,100)}`);return v;
}
const h=(action,body,status=200,user=admin)=>endpoint('holidays',action,status,user,body),p=(action,body,status=200,user=admin)=>endpoint('payroll',action,status,user,body),w=(action,body,status=200,user=admin)=>endpoint('workforce',action,status,user,body),facts=(day,user=admin,id=staffId,query='')=>endpoint('holidays','facts',200,user,undefined,'?employee='+id+'&day='+day+query),listing=(user=admin,query='')=>endpoint('holidays','list',200,user,undefined,query),paylist=id=>endpoint('payroll','list',200,admin,undefined,id?'?period='+id:'');
async function person(role,name,num){const u={email:(num+'@walshken.test').toLowerCase(),password:secret(),cookie:''},v=await request('employees/add',201,admin,{...employee,name,email:u.email,employeeNo:num,role});await request('session/activate',200,u,{email:u.email,password:u.password,code:v.code});await request('session/login',200,u,u);await enroll(u);u.id=(await request('view/employees',200,admin)).rows.find(r=>r.email===u.email).id;return u;}
const hr=await person('hr','Independent holiday reviewer','H-HR-'+runId),outside=await person('employee','Other employee','H-OUT-'+runId);
await db.prepare("UPDATE employees SET country='CA',jurisdiction='CA-AB',time_zone='America/Edmonton',hire_date='2024-01-02',contract_start='2024-01-05',leave_days=20 WHERE id=?",[adminId]).run();
await h('event-create',{day:''},400);await endpoint('holidays','facts',400,admin,undefined,'?employee='+staffId);await endpoint('holidays','list',401,null);await endpoint('holidays','list',403,guest);await h('assignment-save',{},403,staff);await endpoint('holidays','private-record',404,outside,undefined,'?employee='+staffId);await request('view/holiday-calendar',200,staff);assert.equal((await request('view/holidays',200,admin)).managedHolidays,true);
assert.equal(canadianCalendars.length,14);const counts={'CA-AB':9,'CA-BC':11,'CA-SK':10,'CA-MB':9,'CA-ON':9,'CA-QC':8,'CA-NB':8,'CA-NS':6,'CA-PE':8,'CA-NL':6,'CA-YT':11,'CA-NT':11,'CA-NU':11,'CA-FED':10};for(const c of canadianCalendars){assert.equal(holidayDates(c,2026).filter(h=>h.status==='Statutory').length,counts[c.code],c.code);for(const y of [2026,2027,2028])assert.ok(holidayDates(c,y).every(h=>h.date.startsWith(String(y))));}
const ab=canadianCalendars.find(c=>c.code==='CA-AB');assert.equal(holidayDates(ab,2026).find(h=>h.key==='victoria').date,'2026-05-18');assert.equal(holidayDates(ab,2027).find(h=>h.key==='good-friday').date,'2027-03-26');assert.equal(holidayDates(ab,2028).find(h=>h.key==='family').date,'2028-02-21');assert.equal(holidayDates(canadianCalendars.find(c=>c.code==='CA-MB'),2026).find(h=>h.key==='remembrance').status,'Special law');assert.equal(holidayDates(canadianCalendars.find(c=>c.code==='CA-QC'),2026,'Easter Monday').find(h=>h.key==='quebec-easter').date,'2026-04-06');
console.log('PASS all fourteen Canadian legal calendars, movable dates, statutory/optional/special-law distinctions and scoped access');
await p('settings-save',{revision:0,legalName:'Isolated verified employer',address:'Local private employment record',country:'CA',businessNumber:'LOCAL-ONLY',statementNote:'Isolated tests only'});await p('permission-save',{employee:hr.id,organizationAccess:true});
if(process.env.WALSHKEN_TEST_ENTERPRISE_ONLY==='1'){
 globalThis.Date=RealDate;process.env.WALSHKEN_STAFF_READINESS_ENABLED='1';process.env.WALSHKEN_EMPLOYMENT_ENGINE_ENABLED='1';
 await request('view/governance',200,admin);const {verifyEnterprise}=await import('./verify-enterprise.mjs');await verifyEnterprise({db,request,admin,staff,hr,person,adminId,staffId,runId});if(process.env.WALSHKEN_TEST_SOURCE==='1'){const {verifyCompletion}=await import('./verify-completion.mjs');await verifyCompletion({db,request,admin,staff,hr,person,adminId,staffId,runId});}if(process.env.WALSHKEN_TEST_FINAL_OPS==="1"){const {verifyFinalOperations}=await import("./verify-final-operations.mjs");await verifyFinalOperations({db,request,admin,staff,hr,adminId,staffId,runId});}console.log('ENTERPRISE INTEGRATION TESTS PASSED');process.exit(0);
}
const policy={...defaultPayPolicy(employee),frequency:'Weekly',reviewed:true,reference:'Verified TD1 and standard employment agreement'};
async function setup(target){await p('profile-save',{employee:target,effectiveOn:'2026-01-01',currentId:'',note:'Verified payroll profile',policy},201);await p('rate-add',{employee:target,amount:'25',currency:'CAD',effectiveOn:'2026-01-01',unit:'Hour',note:'Authorized actual effective rate'},201);const o=await p('opening-add',{employee:target,year:2026,asOf:'2025-12-31',balances:Object.fromEntries(Object.keys(zeroBalance()).map(k=>[k,'0'])),reference:'Confirmed no previous 2026 payroll in isolated test'},201);await p('opening-review',{id:o.id,revision:1,decision:'Approved',note:'Independently verified opening balances'},200,hr);await h('private-record-save',{employee:target,currentId:'',dateOfBirth:'1990-03-08',address:'Private isolated home address',reference:'Verified private employment evidence'},201);return h('assignment-save',{country:'CA',province:'AB',jurisdiction:'CA-AB',calendar:'CA-AB',effectiveOn:'2026-01-01',location:'Verified Calgary work location',office:'',ruleId:'holiday-rule-CA-AB-2026-v1',reference:'Verified employment location and schedule',weekdays:[1,2,3,4,5],dailyMinutes:480,targetType:'Employees',employees:[target],currentId:''},201);}
await setup(staffId);assert.ok((await request('view/profile',200,staff)).row.holiday_calendar.includes('Alberta'));let f=await facts('2026-07-01');assert.equal(f.eligible,null);assert.ok(f.issues.some(x=>x.includes('complete work-history')));await h('assessment-submit',{employee:staffId,day:'2026-07-01',reference:'Cannot assume missing history means ineligible'},409);
const csv='date,worked_hours,ordinary_wages,worked\n'+['2026-05-18','2026-05-19','2026-05-20','2026-05-21','2026-05-22','2026-05-25','2026-05-26','2026-05-27','2026-05-28','2026-05-29',...Array.from({length:28},(_,i)=>dayAdd('2026-06-03',i)).filter(d=>![0,6].includes(new Date(d+'T12:00Z').getUTCDay()))].map(d=>d+',8,200.00,true').join('\n');
const hist=await h('history-submit',{employee:staffId,from:'2025-07-01',through:'2026-06-30',csv,completeCoverage:true,previousPayPeriodEnd:'2026-06-26',reference:'Verified actual daily work and ordinary wage records'},201);await h('history-review',{id:hist.id,revision:1,decision:'Approved',note:'Self approval forbidden'},403);await h('history-review',{id:hist.id,revision:1,decision:'Approved',note:'Independently reconciled source and complete dates'},200,hr);f=await facts('2026-07-01');assert.equal(f.workdaysPastYear,30);assert.equal(f.averageDailyWage,20000);assert.equal(f.totalOwing,20000);assert.equal(f.eligible,true);assert.deepEqual(f.issues,[]);
async function approvedWork(day,target=staffId){const a=await w('manual-entry',{employee:target,startsAt:localInstant(day+'T09:00','America/Edmonton'),endsAt:localInstant(day+'T17:30','America/Edmonton'),timeZone:'America/Edmonton',breaks:[{kind:'lunch',startsAt:localInstant(day+'T12:00','America/Edmonton'),endsAt:localInstant(day+'T12:30','America/Edmonton')}],note:'Actual isolated work with recorded unpaid lunch'},201);const s=await db.prepare('SELECT * FROM timesheets WHERE attendance_id=?',[a.id]).first();await w('timesheet-review',{id:s.id,revision:s.revision,decision:'Approved',note:'Verified work and statutory break',acknowledge:true},200,hr);return a;}
await approvedWork('2026-07-01');f=await facts('2026-07-01');assert.equal(f.workedSeconds,8*3600);assert.equal(f.premiumMinor,30000);assert.equal(f.totalOwing,50000);const alt=await facts('2026-07-01',admin,staffId,'&windowMethod=Previous%20pay%20period&previousPeriodEnd=2026-06-26');assert.equal(alt.windowStart,'2026-05-30');assert.equal(alt.averageDailyWage,20000);await endpoint('holidays','facts',400,admin,undefined,'?employee='+staffId+'&day=2026-07-01&windowMethod=Previous%20pay%20period&previousPeriodEnd=2026-06-25');
async function assessment(day,target=staffId){const a=await h('assessment-submit',{employee:target,day,reference:'Calculated from verified source and legal version'},201);await h('assessment-review',{id:a.id,revision:1,decision:'Approved',note:'Independent actual evidence and calculation review'},200,hr);return a;}
const a1=await assessment('2026-07-01');await assert.rejects(()=>db.prepare("UPDATE holiday_histories SET reference='silent' WHERE id=?",[hist.id]).run(),/immutable/i);await assert.rejects(()=>db.prepare("DELETE FROM holiday_assessments WHERE id=?",[a1.id]).run(),/immutable/i);await p('item-add',{kind:'Holiday decision'},404);await w('holiday-create',{},404);
console.log('PASS evidence-based 30-workday eligibility, both ADW windows, actual worked-holiday premium, approval separation, immutable evidence and legacy bypass rejection');
async function period(label,from,to,target=staffId){return(await p('period-create',{label,startsOn:from,endsOn:to,payDate:to,frequency:'Weekly',periodsPerYear:52,employees:[target]},201)).id;}
async function finalize(periodId,target=staffId){await p('calculate',{period:periodId,employee:target});let d=await paylist(periodId);await p('period-submit',{id:periodId,revision:d.selected.revision});d=await paylist(periodId);await p('payroll-review',{id:d.rows[0].id,revision:d.rows[0].revision,decision:'Approved',note:'Verified exact wage, compliance and deductions',acknowledge:true},200,hr);d=await paylist(periodId);await p('period-finalize',{id:periodId,revision:d.selected.revision,note:'Reviewed statutory sources and complete roster'});return(await paylist(periodId)).rows[0];}
const per=await period('Verified Canada Day','2026-06-29','2026-07-05');let row=await finalize(per);assert.equal(row.gross_cents,50000);assert.equal(row.calculation.compliance.rules.version,'CA-AB-employment-2026-v1');assert.equal((await db.prepare('SELECT count(*)::int AS n FROM holiday_allocations WHERE payroll_id=?',[row.id]).first()).n,3);const pdf=await endpoint('payroll','payslip',200,staff,undefined,'?id='+row.id);assert.ok(pdf.subarray(0,5).toString()==='%PDF-');
const rawPrivate=await db.prepare('SELECT configuration FROM holiday_private_records WHERE employee_id=?',[staffId]).first();assert.ok(!rawPrivate.configuration.includes('1990-03-08'));assert.equal((await endpoint('holidays','private-record',200,staff)).record.dateOfBirth,'1990-03-08');assert.ok((await listing(staff)).audit.some(a=>a.action==='Protected employment record opened'));
const csvExport=await endpoint('holidays','export',200,staff);assert.ok(csvExport.includes('Canada Day'));assert.ok(!csvExport.includes('Other employee'));await endpoint('holidays','facts',404,outside,undefined,'?employee='+staffId+'&day=2026-07-01');
console.log('PASS payroll holiday allocation, immutable legal snapshots, private payslip/CSV, encrypted employment records and employee-only financial visibility');
// Company observations and closures are separate from mandatory entitlements.
const ev={jurisdiction:'CA-AB',day:'2026-12-26',kind:'Optional observance',calendarKey:'boxing',name:'Observed Boxing Day',reference:'Company authorized optional holiday',guaranteedMinutes:480,closed:true,targetType:'Employees',employees:[staffId]};await h('event-create',{...ev,day:'2026-12-25',calendarKey:'christmas'},400);const optional=await h('event-create',ev,201);assert.ok((await listing(admin,'?employee='+staffId)).events.some(e=>e.id===optional.id));await h('event-cancel',{id:optional.id,revision:1,reference:'Future optional benefit revised before observance'});assert.equal((await listing(admin,'?employee='+staffId)).calendar.filter(c=>c.status==='Statutory').length,9);
const close=await h('event-create',{...ev,kind:'Closure',day:'2026-12-10',name:'Company office closure',calendarKey:'',guaranteedMinutes:480},201);await w('shift-create',{employees:[staffId],title:'Must reject closed location',location:'Actual workplace',timeZone:'America/Edmonton',startsLocal:'2026-12-10T09:00',endsLocal:'2026-12-10T17:00'},409);const protectedLeave=await db.prepare("SELECT id,revision FROM leave_requests WHERE note=? AND status='Approved'",['Company closure · '+close.id]).first();await w('leave-cancel',{id:protectedLeave.id,revision:protectedLeave.revision,note:'Cannot remove statutory protection via leave'},409);const workData=await endpoint('workforce','list',200,staff,undefined,'?from=2026-12-01&to=2026-12-31');assert.ok(workData.holidays.some(h=>h.name==='Company office closure'));await h('event-cancel',{id:close.id,revision:1,reference:'Future closure lawfully changed'});assert.equal((await db.prepare('SELECT status FROM leave_requests WHERE id=?',[protectedLeave.id]).first()).status,'Cancelled');
console.log('PASS optional observation, mandatory-date protection, scoped closures, published-schedule integration and protected leave cancellation guards');

// Worked-holiday paid-day alternative: actual employee consent, ordinary wages now, ADW on a separate paid day.
await setup(outside.id);const hh=await h('history-submit',{employee:outside.id,from:'2025-07-01',through:'2026-06-30',csv,completeCoverage:true,reference:'Verified source history for actual alternate arrangement'},201);await h('history-review',{id:hh.id,revision:1,decision:'Approved',note:'Independent complete-history review'},200,hr);await approvedWork('2026-07-01',outside.id);
const ex=await h('exception-submit',{employee:outside.id,day:'2026-07-01',kind:'Future paid day',payDay:'2026-07-08',dueBefore:'2026-08-10',agreement:'Written actual employee and employer arrangement',authority:'https://www.alberta.ca/alberta-general-holidays',reference:'Verified worked-holiday paid-day option'},201);await h('exception-review',{id:ex.id,revision:1,decision:'Approved',note:'Independent lawful alternative review'},200,hr);assert.ok((await facts('2026-07-01',admin,outside.id)).issues.some(v=>v.includes('not confirmed')));await h('exception-consent',{id:ex.id,consented:true,note:'Cannot consent on another employee behalf'},404);await h('exception-consent',{id:ex.id,consented:true,note:'I confirm my written normal paid-day arrangement'},200,outside);
let df=await facts('2026-07-01',admin,outside.id);assert.equal(df.method,'Future paid day');assert.equal(df.premiumMinor,0);assert.equal(df.totalOwing,20000);assert.deepEqual(df.issues,[]);await assessment('2026-07-01',outside.id);
const dp=await period('Actual ordinary work before substitute day','2026-06-29','2026-07-05',outside.id);let dr=await finalize(dp,outside.id);assert.equal(dr.gross_cents,20800,'Ordinary wages plus 4% vacation, without statutory work premium');const substitute=await period('Actual paid substitute day','2026-07-06','2026-07-12',outside.id);dr=await finalize(substitute,outside.id);assert.equal(dr.gross_cents,20000);assert.equal(dr.calculation.holidaySeconds,8*3600);
await h('exception-submit',{employee:outside.id,day:'2026-07-01',kind:'Future paid day',payDay:'2026-07-09',dueBefore:'2026-08-10',agreement:'Cannot defer already paid entitlement',authority:'https://www.alberta.ca/alberta-general-holidays',reference:'Retrospective paid-rights conversion must reject'},409);
console.log('PASS authenticated paid-day consent, ordinary-work/holiday-day separation, protected paid-day scheduling and no retrospective paid-rights conversion');
// A revised historical wage creates an exact, auditable underpayment; it cannot rewrite a finalized statement.
const changed=csv.replaceAll(',200.00,true',',220.00,true'),ch=await h('history-submit',{employee:staffId,from:'2025-07-01',through:'2026-06-30',csv:changed,completeCoverage:true,reference:'Verified corrected actual daily ordinary wages'},201);await h('history-review',{id:ch.id,revision:1,decision:'Approved',note:'Independently reconciled the corrected source evidence'},200,hr);await assessment('2026-07-01');let correction=(await listing(admin,'?employee='+staffId)).reconciliations.find(r=>r.status==='Pending');assert.equal(JSON.parse(correction.detail).requiredDelta,2000);await h('reconciliation-close',{id:correction.id,note:'Cannot waive a verified positive entitlement'},409);assert.equal((await paylist(per)).rows[0].gross_cents,50000);
const adjPeriod=await period('Auditable holiday wage correction','2026-07-13','2026-07-19');await p('item-add',{period:adjPeriod,employee:staffId,kind:'Adjustment',label:'Verified holiday underpayment',amount:'19',workDate:'2026-07-13',minutes:0,relatedId:correction.id,reference:'Exact verified entitlement difference'},400);const adj=await p('item-add',{period:adjPeriod,employee:staffId,kind:'Adjustment',label:'Verified holiday underpayment',amount:'20',workDate:'2026-07-13',minutes:0,relatedId:correction.id,reference:'Corrected holiday average wage and retained original payroll',taxable:true,pensionable:true,insurable:true},201);await p('item-review',{id:adj.id,revision:1,decision:'Approved',note:'Authorized exact underpayment correction'},200,hr);const adjRow=await finalize(adjPeriod);assert.equal(adjRow.gross_cents,2000);assert.equal((await listing(admin,'?employee='+staffId)).reconciliations.find(r=>r.id===correction.id).status,'Resolved');
console.log('PASS finalized-pay immutability, exact underpayment adjustments, inability to waive required pay and allocation-based duplicate-credit protection');
// Non-regular worked/unworked company-recognized holidays use the same Alberta rules.
const extension=await h('history-submit',{employee:staffId,from:'2026-07-01',through:'2026-07-03',csv:'date,worked_hours,ordinary_wages,worked',completeCoverage:true,reference:'Verified complete portal coverage after Canada Day'},201);await h('history-review',{id:extension.id,revision:1,decision:'Approved',note:'Verified actual portal records and complete dates'},200,hr);
const saturday=await h('event-create',{jurisdiction:'CA-AB',day:'2026-07-04',kind:'Paid company holiday',calendarKey:'',name:'Authorized company general holiday',reference:'Recognized company holiday under Alberta statutory rules',guaranteedMinutes:0,closed:false,targetType:'Employees',employees:[staffId]},201);let nf=await facts('2026-07-04');assert.equal(nf.regularDay,false);assert.equal(nf.eligible,false);assert.equal(nf.totalOwing,0);
await approvedWork('2026-07-04');nf=await facts('2026-07-04');assert.equal(nf.regularDay,false);assert.equal(nf.eligible,true);assert.equal(nf.dayPayMinor,0);assert.equal(nf.premiumMinor,30000);await assessment('2026-07-04');assert.equal(JSON.parse((await listing(admin,'?employee='+staffId)).reconciliations.find(r=>r.holiday_date==='2026-07-04'&&r.status==='Pending').detail).requiredDelta,30000);
// A holiday inside actual approved vacation must be moved to a separate normal paid day.
const vacationer=await person('employee','Vacation entitlement employee','H-VAC-'+runId);await setup(vacationer.id);const vh=await h('history-submit',{employee:vacationer.id,from:'2025-07-01',through:'2026-06-30',csv,completeCoverage:true,reference:'Verified complete daily records before vacation'},201);await h('history-review',{id:vh.id,revision:1,decision:'Approved',note:'Independent coverage and wage verification'},200,hr);const vacation=await w('leave-record',{employee:vacationer.id,category:'Vacation',startsOn:'2026-06-29',endsOn:'2026-07-03',note:'Authorized actual annual vacation'},201);assert.ok((await facts('2026-07-01',admin,vacationer.id)).issues.some(v=>v.includes('vacation requires')));const ve=await h('exception-submit',{employee:vacationer.id,day:'2026-07-01',kind:'Vacation deferral',payDay:'2026-07-08',dueBefore:'2026-08-10',vacationId:vacation.id,agreement:'Written normal paid-day agreement after annual vacation',authority:'https://www.alberta.ca/alberta-general-holidays',reference:'Confirmed holiday during approved vacation'},201);await h('exception-review',{id:ve.id,revision:1,decision:'Approved',note:'Independent statutory vacation-day review'},200,hr);await h('exception-consent',{id:ve.id,consented:true,note:'I agree to the separate paid normal day'},200,vacationer);await assessment('2026-07-01',vacationer.id);const vp=await period('Vacation substitute entitlement','2026-07-06','2026-07-12',vacationer.id);assert.equal((await finalize(vp,vacationer.id)).gross_cents,20000);
// An untaken paid day is settled on termination according to who ended employment.
const ended=await person('employee','Untaken holiday settlement employee','H-END-'+runId);await setup(ended.id);const eh=await h('history-submit',{employee:ended.id,from:'2025-07-01',through:'2026-06-30',csv,completeCoverage:true,reference:'Verified work and ordinary wages before termination'},201);await h('history-review',{id:eh.id,revision:1,decision:'Approved',note:'Independently verified complete employment evidence'},200,hr);await approvedWork('2026-07-01',ended.id);const ee=await h('exception-submit',{employee:ended.id,day:'2026-07-01',kind:'Future paid day',payDay:'2026-07-08',dueBefore:'2026-08-10',agreement:'Actual approved future paid day',authority:'https://www.alberta.ca/alberta-general-holidays',reference:'Verified lawful worked-holiday arrangement'},201);await h('exception-review',{id:ee.id,revision:1,decision:'Approved',note:'Independent evidence review'},200,hr);await h('exception-consent',{id:ee.id,consented:true,note:'I confirm the agreed paid day'},200,ended);await assessment('2026-07-01',ended.id);const ep=await period('Ordinary holiday work before employer termination','2026-06-29','2026-07-05',ended.id);assert.equal((await finalize(ep,ended.id)).gross_cents,20800);await db.prepare("UPDATE employees SET employment_end='2026-07-06',employment_status='Ended' WHERE id=?",[ended.id]).run();const er=await endpoint('holidays','private-record',200,admin,undefined,'?employee='+ended.id);await h('private-record-save',{employee:ended.id,currentId:er.record.id,dateOfBirth:er.record.dateOfBirth,address:er.record.address,terminationReason:'Employer termination',reference:'Verified employer termination and untaken paid day'},201);let ef=await facts('2026-07-01',admin,ended.id);assert.equal(ef.payDay,'2026-07-06');assert.equal(ef.dayPayMinor,20000);assert.equal(ef.settlementMinor,10000);assert.deepEqual(ef.issues,[]);await assessment('2026-07-01',ended.id);const endPeriod=await period('Untaken holiday employer-termination settlement','2026-07-06','2026-07-12',ended.id);const endRow=await finalize(endPeriod,ended.id);assert.equal(endRow.gross_cents,30000);
console.log('PASS non-regular worked/unworked general holidays, actual vacation deferral and employer-termination settlement of untaken paid days');
// Actual Part F no-show records require review; an administrative checkbox cannot invent an adverse exception.
await h('exception-submit',{employee:vacationer.id,day:'2026-07-01',kind:'Unauthorized adjacent absence',shiftId:'does-not-exist',authority:'https://www.alberta.ca/alberta-general-holidays',reference:'A fictitious absence must never waive statutory pay'},400);
const absentShift='local-absence-'+runId,absentId='local-no-show-'+runId;await db.prepare("INSERT INTO shifts(id,org_id,employee_id,starts_at,ends_at,title,location,created_by,published,release_stage,workflow_version,state,time_zone,policy_snapshot) VALUES(?,?,?,?,?,?,?,?,1,'preview',1,'Published','America/Edmonton',?)",[absentShift,'walshken',staffId,localInstant('2026-06-30T09:00','America/Edmonton'),localInstant('2026-06-30T17:00','America/Edmonton'),'Historical scheduled work','Actual verified workplace',adminId,JSON.stringify(defaultPolicy())]).run();await db.prepare("INSERT INTO attendance_absences(id,org_id,release_stage,shift_id,employee_id,status,recorded_at,updated_at) VALUES(?,'walshken','preview',?,?,'No show',?,?)",[absentId,absentShift,staffId,new Date().toISOString(),new Date().toISOString()]).run();assert.ok((await facts('2026-07-01')).issues.some(v=>v.includes('Review the recorded absence')));const adverse=await h('exception-submit',{employee:staffId,day:'2026-07-01',kind:'Unauthorized adjacent absence',shiftId:absentShift,authority:'https://www.alberta.ca/alberta-general-holidays',reference:'Verified actual required adjacent shift without employer consent'},201);await h('exception-review',{id:adverse.id,revision:1,decision:'Approved',note:'Independently checked actual unexcused absence'},200,hr);assert.equal((await facts('2026-07-01')).eligible,false);await w('absence-excuse',{id:absentId,note:'Verified employer consent and corrected absence evidence'});assert.ok((await facts('2026-07-01')).issues.some(v=>v.includes('no longer matches')));const wd=await h('exception-submit',{employee:staffId,day:'2026-07-01',kind:'Withdraw exception',withdrawsId:adverse.id,authority:'https://www.alberta.ca/alberta-general-holidays',reference:'Original absence was confirmed excused; restore statutory eligibility'},201);await h('exception-review',{id:wd.id,revision:1,decision:'Approved',note:'Independently verified restored eligibility'},200,hr);assert.equal((await facts('2026-07-01')).eligible,true);
for(const table of ['holiday_rules','holiday_assignments','holiday_histories','holiday_assessments','holiday_private_records','holiday_audit'])assert.equal((await db.prepare('SELECT has_table_privilege(\'walshken_production_app\',?,\'SELECT\') AS ok',[table]).first()).ok,false,table);
console.log('PASS actual no-show evidence, consented-absence restoration, independently approved exception withdrawal and default-deny production access');
// New employment-rule versions cannot weaken statutory or already-promised floors.
const version={jurisdiction:'CA-AB',version:'CA-AB-company-2026-12-v2',effectiveFrom:'2026-12-01',effectiveThrough:'2028-12-31',reference:'Verified approved stronger company work standards',reviewed:true};await h('rule-version-create',{...version,weeklyOvertimeHours:45},400);await h('rule-version-create',{...version,minimumBreakMinutes:29},400);await h('rule-version-create',{...version,vacationInitialPercent:'3'},400);const ver=await h('rule-version-create',{...version,weeklyOvertimeHours:40,vacationInitialPercent:'5'},201);const {employmentRulesOn}=await import('../lib/walshken/holiday-access.ts'),{one}=await import('../lib/walshken/server.ts');const staffActor=await one(db,'SELECT * FROM employees WHERE id=?',staffId);assert.equal((await employmentRulesOn(db,staffActor,'2026-07-01')).rules.weeklyOvertimeHours,44);assert.equal((await employmentRulesOn(db,staffActor,'2026-12-10')).rules.weeklyOvertimeHours,40);assert.equal((await employmentRulesOn(db,staffActor,'2026-12-10')).row.id,ver.id);assert.equal((await paylist(per)).rows[0].calculation.compliance.rules.version,'CA-AB-employment-2026-v1');await assert.rejects(()=>db.prepare("UPDATE holiday_rules SET version='silent' WHERE id=?",[ver.id]).run(),/immutable/i);
console.log('PASS effective rule versions, mandatory floors, preserved historical rule snapshots and no old-assignment bypass');
writeFileSync('/tmp/walshken-holiday-ui-data.json',JSON.stringify({actor:{id:adminId,name:'Holiday administrator',role:'super_admin',timeZone:'America/Edmonton'},data:await listing(admin,'?employee='+staffId)}));
const { verifyCalendar } = await import('./verify-calendar.mjs');
const calendar = await verifyCalendar({ request, db, admin, staff, outsider: outside, staffId, adminId, department, person, runId, defaultPolicy, localInstant });
if (process.env.WALSHKEN_CALENDAR_TEST_EXPORT) writeFileSync(process.env.WALSHKEN_CALENDAR_TEST_EXPORT, JSON.stringify(calendar));
if (process.env.WALSHKEN_TEST_READINESS==="1") {
  globalThis.Date=RealDate;
  process.env.WALSHKEN_STAFF_READINESS_ENABLED="1";
  const route = (path,status,user,data) => request("governance/"+path,status,user,data);
  const jurisdiction = {country:"IN",jurisdiction:"IN-DL",classification:"Office worker",version:"QA-Delhi-v1",
    effectiveFrom:"2026-01-01",effectiveThrough:"2026-12-31",source:"https://law.delhi.gov.in/node/8508",
    evidence:"Exercise evidence review using a fictional Delhi office."};
  await route("jurisdiction-save",403,staff,jurisdiction);
  await route("jurisdiction-save",400,admin,{...jurisdiction,country:"PK"});
  await route("jurisdiction-save",201,admin,jurisdiction);
  const settings=await request("view/governance",200,admin);
  const entry=settings.jurisdictionPolicies.find(row=>row.version===jurisdiction.version);
  assert.equal(entry.status,"Draft");
  await route("jurisdiction-verify",403,admin,{id:entry.id,reason:"Self approval is prohibited"});
  await route("jurisdiction-withdraw",200,admin,{id:entry.id,reason:"Archive the fictional review example"});
  assert.equal((await request("view/governance",200,admin)).jurisdictionPolicies[0].status,"Withdrawn");
  await route("notice-publish",200,admin,{title:"Private staff information",body:"Fictional review notice with records subject to scoped portal access."});
  const notice=(await request("view/profile",200,staff)).privacyNotice;
  await route("notice-acknowledge",409,staff,{id:"unknown-notice"});
  await route("notice-acknowledge",200,staff,{id:notice.id});
  await route("notice-acknowledge",200,staff,{id:notice.id});
  assert.ok((await request("view/profile",200,staff)).privacyNotice.acknowledged_at);
  await route("permission-save",200,admin,{principalType:"role",principal:"manager",scopeType:"employee",scopeId:staffId,capability:"people.read",effect:"deny"});
  assert.equal((await request("view/governance",200,admin)).rows[0].effect,"deny");
  await request("view/audit",200,admin);
  const {managementOverview}=await import("../lib/walshken/staff-oversight.ts");
  const management=await managementOverview(db,await one(db,"SELECT * FROM employees WHERE id=?",adminId));
  assert.ok(management.people.employees >= 2);
  const {workforcePolicy}=await import("../lib/walshken/workforce.ts");
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const workSeed={...defaultPolicy(),manualAllowed:true};
  await w("policy-save",{employee:staffId,revision:(await workforcePolicy(db,staffActor)).revision,policy:workSeed,effectiveOn:tomorrow});
  assert.equal((await workforcePolicy(db,staffActor,tomorrow)).policy.manualAllowed,true);
  const orgUnit = "QA Office Review";
  await request("organization/add",201,admin,{kind:"Office",name:orgUnit,country:"IN",region:"Delhi",timeZone:"Asia/Kolkata"});
  const office=(await request("view/departments",200,admin)).rows.find(row=>row.name===orgUnit);
  await request("organization/edit",403,staff,{id:office.id,name:"Changed office",country:"IN",region:"Delhi",timeZone:"Asia/Kolkata"});
  await request("organization/edit",200,admin,{id:office.id,name:"Changed office",country:"IN",region:"Delhi",timeZone:"Asia/Kolkata"});
  await request("organization/delete-unused",400,admin,{id:office.id,confirmation:""});
  await request("organization/delete-unused",200,admin,{id:office.id,confirmation:"DELETE"});
  assert.equal((await request("view/departments",200,admin)).rows.some(row=>row.id===office.id),false);
  const paySettings=await paylist();
  await p("settings-save",{...paySettings.settings,revision:paySettings.settingsRevision,independentApproval:true});
  assert.equal(defaultPayPolicy({country:"PK",jurisdiction:"PK-PB"}).currency,"PKR");
  assert.equal(defaultPayPolicy({country:"IN",jurisdiction:"IN-DL"}).overtime,"Configured rule");
  const shortWorker=await person('employee','Reporting pay regression employee','H-SHORT-'+runId);
  await setup(shortWorker.id);
  const shortId=(await w('manual-entry',{employee:shortWorker.id,startsAt:localInstant('2026-08-20T09:00','America/Edmonton'),
    endsAt:localInstant('2026-08-20T10:00','America/Edmonton'),breaks:[],note:'Required one-hour reporting period'},201)).id;
  const shortSheet=await db.prepare('SELECT * FROM timesheets WHERE attendance_id=?',[shortId]).first();
  await w('timesheet-review',{id:shortSheet.id,revision:shortSheet.revision,decision:'Approved',note:'Verified required reporting',acknowledge:true},200,hr);
  const shortPeriod=await period('Required reporting pay','2026-08-17','2026-08-23',shortWorker.id);
  await p('calculate',{period:shortPeriod,employee:shortWorker.id});
  let shortResult=await paylist(shortPeriod);
  assert.equal(shortResult.rows[0].calculation.lines.find(line=>line.kind==="Reporting pay").amount,2000);
  assert.equal(shortResult.rows[0].regular_seconds,3600);
  await p('period-submit',{id:shortPeriod,revision:shortResult.selected.revision});
  shortResult=await paylist(shortPeriod);
  const review={id:shortResult.rows[0].id,revision:shortResult.rows[0].revision,decision:"Approved",note:"Independent review of the required work",acknowledge:true};
  await p("payroll-review",review,403,admin);
  await p("payroll-review",review,200,hr);
  console.log("PASS organization unit management, local currency defaults, reporting pay calculation and independent payroll approval");
  await assert.rejects(()=>db.prepare("UPDATE staff_jurisdiction_versions SET version='silent' WHERE id=?",[entry.id]).run(),/immutable/i);
  console.log("PASS governance, independent jurisdiction review, staff privacy, scoped permission changes, oversight and effective-dated break policy");
}
if(process.env.WALSHKEN_TEST_EMPLOYMENT==="1") {
 const {verifyEmployment}=await import('./verify-employment.mjs');
 await verifyEmployment({db,request,admin,staff,hr,person,adminId,staffId,runId});
}
if(process.env.WALSHKEN_TEST_ENTERPRISE==='1'){
 const {verifyEnterprise}=await import('./verify-enterprise.mjs');await verifyEnterprise({db,request,admin,staff,hr,person,adminId,staffId,runId});
}
console.log('PART H HOLIDAY TESTS PASSED');globalThis.Date=RealDate;process.exit(0);
