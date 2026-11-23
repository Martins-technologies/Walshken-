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
copyFileSync(join(process.cwd(),'supabase/migrations/20261123114028_employee_salary_payroll.sql'),join(sandbox,'drizzle/0013_payroll.sql'));
mkdirSync(join(sandbox,'public'));copyFileSync(join(process.cwd(),'public/payroll-font.ttf'),join(sandbox,'public/payroll-font.ttf'));
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
  const setup=await request("mfa/setup", 200, account, {password:account.password});
  const first=authenticatorCode(setup.setupKey,-1);
  const confirmed=await request("mfa/confirm", 200, account, {password:account.password,code:first});
  assert.equal(confirmed.recoveryCodes.length,8);
  await request("view/profile",401,account);
  const mfaCode=authenticatorCode(setup.setupKey,0);
  await request("session/login",200,account,{email:account.email,password:account.password,mfaCode});
  return {...confirmed,mfaCode};
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

process.env.WALSHKEN_ATTENDANCE_ENABLED='1';process.env.WALSHKEN_WORK_DATASET='preview';process.env.WALSHKEN_PAYROLL_ENABLED='1';process.env.WALSHKEN_PAYROLL_DATASET='preview';process.env.WALSHKEN_RELEASE_SCOPE='staff-payroll';
const {GET:payGet,POST:payPost}=await import('../app/api/payroll/[action]/route.ts');
const {GET:workGet,POST:workPost}=await import('../app/api/workforce/[action]/route.ts');
const {defaultPayPolicy,hash}=await import('../lib/walshken/payroll-access.ts');const {zeroBalance,minor,currencyDigits}=await import('../lib/walshken/payroll-money.ts');const {canadianAlbertaTax}=await import('../lib/walshken/payroll-tax-ca.ts');const {defaultPolicy,localInstant,dayAdd}=await import('../lib/walshken/attendance-rules.ts');const {PDFDocument}=await import('pdf-lib');
async function endpoint(kind,action,expected=200,user=admin,body,query=''){
 const req=new Request(origin+'/api/'+kind+'/'+action+query,{method:body===undefined?'GET':'POST',headers:{origin,...(user?.cookie?{cookie:user.cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});const response=await(body===undefined?(kind==='payroll'?payGet:workGet):(kind==='payroll'?payPost:workPost))(req,{params:Promise.resolve({action})}),type=response.headers.get('Content-Type')??'',result=type.includes('json')?await response.json():type.includes('pdf')?Buffer.from(await response.arrayBuffer()):await response.text();assert.equal(response.status,expected,`${kind}/${action}: expected ${expected} got ${response.status}: ${result?.error??String(result).slice(0,100)}`);return result;
}
const post=(action,body,status=200,user=admin)=>endpoint('payroll',action,status,user,body),list=(user=admin,id='')=>endpoint('payroll','list',200,user,undefined,id?'?period='+id:'');
const work=(action,body,status=200,user=admin)=>endpoint('workforce',action,status,user,body);
async function person(role,name,employeeNo){const u={email:(employeeNo+'@walshken.test').toLowerCase(),password:secret(),cookie:''};const invite=await request('employees/add',201,admin,{...employee,name,email:u.email,employeeNo,role});await request('session/activate',200,u,{email:u.email,password:u.password,code:invite.code});await request('session/login',200,u,u);await enroll(u);u.id=(await request('view/employees',200,admin)).rows.find(r=>r.email===u.email).id;return u;}
const hr=await person('hr','Payroll reviewer','PAY-HR-'+runId),outsider=await person('employee','Other employee','PAY-OUT-'+runId),managerUser=await person('manager','Team coordinator','PAY-M-'+runId);
await db.prepare("UPDATE employees SET country='CA',jurisdiction='CA-AB',time_zone='America/Edmonton',hire_date='2020-01-01',contract_start='2020-01-01' WHERE id=?",[adminId]).run();
await endpoint('payroll','list',401,null);await endpoint('payroll','list',403,guest);await post('settings-save',{},403,staff);await post('settings-save',{},403,managerUser);assert.equal((await request('view/salary',200,staff)).managedPayroll,true);assert.equal((await request('view/payroll',200,admin)).managedPayroll,true);await request('payroll/estimate',404,admin,{});
const policy={...defaultPayPolicy(employee),frequency:'Weekly',reviewed:true,reference:'Verified TD1 and employment records'};const taxInput={payDate:'2026-03-20',currency:'CAD',periods:52,periodIndex:12,taxable:130000,pensionable:130000,insurable:130000,bonus:0,bonusPensionable:0,bonusInsurable:0,pretax:8000,bonusPretax:0,lastRegular:0,ytd:zeroBalance(),profile:policy.taxProfile};
let tax=canadianAlbertaTax(taxInput),ded=code=>tax.lines.find(l=>l.code===code).employee;assert.equal(ded('CPP'),7335);assert.equal(ded('EI'),2119);assert.equal(tax.annualTaxable,'62798.84');assert.equal(ded('FED')+ded('AB'),17020);
tax=canadianAlbertaTax({...taxInput,taxable:160000,pensionable:160000,insurable:160000,pretax:0,ytd:{...zeroBalance(),cpp:423045,cpp2:2400,ei:112307,pensionable:7520000},profile:{...policy.taxProfile,provincialClaim:'Custom',provincialClaimAmount:'60000'}});assert.equal(ded('CPP2'),6400);assert.equal(ded('CPP'),0);assert.equal(ded('EI'),0);assert.equal(tax.annualTaxable,'79872.00');assert.equal(ded('FED')+ded('AB'),21018);
tax=canadianAlbertaTax({...taxInput,taxable:350000,pensionable:350000,insurable:350000,bonus:250000,bonusPensionable:250000,bonusInsurable:250000,pretax:0,ytd:{...zeroBalance(),bonus:150000,bonusEnhanced:1460,bonusCpp:8925,bonusEi:2445}});assert.equal(tax.annualTaxable,'55450.76');assert.equal(tax.bonusEnhanced,2452);assert.equal(tax.bonusCpp,14875);assert.equal(tax.bonusEi,4075);
assert.throws(()=>canadianAlbertaTax({...taxInput,payDate:'2027-01-01'}));assert.throws(()=>canadianAlbertaTax({...taxInput,currency:'USD'}));assert.equal(minor('12.345',3),12345);assert.equal(currencyDigits('JPY'),0);assert.throws(()=>minor('12.345',2));assert.throws(()=>minor('-1',2));
console.log('PASS CRA regular remuneration and above-YMPE examples, Alberta supplementary credit, non-periodic annualization, exact money, currency precision, future-year guards');
await post('settings-save',{revision:0,legalName:'Isolated test employer',address:'Private local test address',country:'CA',businessNumber:'LOCAL-ONLY',statementNote:'Local calculation verification'});
await post('permission-save',{employee:hr.id,organizationAccess:true});
async function setupEmployee(target,rate='30',unit='Hour',custom=policy){await post('profile-save',{employee:target,effectiveOn:'2026-01-01',currentId:'',note:'Verified payroll setup',policy:custom},201);await post('rate-add',{employee:target,amount:rate,currency:custom.currency,effectiveOn:'2026-01-01',unit,note:'Authorized effective rate'},201);const o=await post('opening-add',{employee:target,year:2026,asOf:'2025-12-31',balances:Object.fromEntries(Object.keys(zeroBalance()).map(k=>[k,'0'])),reference:'Confirmed no prior 2026 pay in isolated fixture'},201);await post('opening-review',{id:o.id,revision:1,decision:'Approved',note:'Verified zero balances'},200,target===adminId?hr:admin);}
await setupEmployee(staffId);await setupEmployee(adminId,'52000','Year');
const period=(label,start,end,employees=[staffId],frequency='Weekly')=>post('period-create',{label,startsOn:start,endsOn:end,payDate:end,frequency,periodsPerYear:frequency==='Weekly'?52:frequency==='Biweekly'?26:frequency==='Monthly'?12:24,employees},201);
const period1=(await period('First verified weekly pay','2026-02-02','2026-02-08')).id;
async function approvedWork(day,start='09:00',end='17:00',who=staffId){const a=await work('manual-entry',{employee:who,startsAt:localInstant(day+'T'+start,'America/Edmonton'),endsAt:localInstant(day+'T'+end,'America/Edmonton'),note:'Verified local work interval',breaks:[{kind:'lunch',startsAt:localInstant(day+'T12:00','America/Edmonton'),endsAt:localInstant(day+'T12:30','America/Edmonton')}]},201);const s=await db.prepare('SELECT * FROM timesheets WHERE attendance_id=?',[a.id]).first();await work('timesheet-review',{id:s.id,revision:s.revision,decision:'Approved',note:'Checked completed work',acknowledge:true},200,who===adminId?hr:admin);return {attendance:a.id,sheet:s.id};}
await approvedWork('2026-02-02');await approvedWork('2026-02-03');const longWork=await approvedWork('2026-02-04','09:00','19:00');
await post('calculate',{period:period1,employee:staffId});let d=await list(admin,period1),row=d.rows[0];assert.equal(row.regular_seconds,23*3600);assert.equal(row.overtime_seconds,1.5*3600);assert.equal(row.unpaid_break_seconds,5400);assert.equal(row.gross_cents,78510);assert.equal(row.calculation.vacationAccrued,2760);assert.equal((await list(staff)).rows.length,0);await endpoint('payroll','detail',404,outsider,undefined,'?id='+row.id);await endpoint('payroll','payslip',409,admin,undefined,'?id='+row.id);assert.equal((await list(managerUser)).staff.length,1);await post('calculate',{period:period1,employee:outsider.id},400);
const bonus=await post('item-add',{period:period1,employee:staffId,kind:'Bonus',label:'Approved performance bonus',amount:'100',workDate:'2026-02-05',minutes:0,reference:'Manager written approval',taxable:true,pensionable:true,insurable:true,vacationable:false},201);await post('calculate',{period:period1,employee:staffId},409);await post('item-review',{id:bonus.id,revision:1,decision:'Approved',note:'Verified authority and amount'});await post('calculate',{period:period1,employee:staffId});d=await list(admin,period1);row=d.rows[0];assert.equal(row.gross_cents,88510);assert.equal(row.calculation.tax.bonus,10000);
await post('period-submit',{id:period1,revision:d.selected.revision});d=await list(admin,period1);row=d.rows[0];await post('payroll-review',{id:row.id,revision:row.revision,decision:'Approved',note:'Checked hours and deductions',acknowledge:true});d=await list(admin,period1);assert.equal(d.selected.status,'Approved');
// A legitimate new effective rate invalidates an already-approved estimate.
await post('rate-add',{employee:staffId,amount:'31',currency:'CAD',effectiveOn:'2026-02-04',unit:'Hour',note:'Authorized mid-period wage change'},201);await post('period-finalize',{id:period1,revision:d.selected.revision,note:'Finalize checked payroll'},409);await post('period-reopen',{id:period1,revision:d.selected.revision,note:'Recalculate authorized wage change'});await post('calculate',{period:period1,employee:staffId});d=await list(admin,period1);assert.equal(d.rows[0].calculation.lines.filter(l=>l.kind==='Regular').at(-1).rate,3100);await post('period-submit',{id:period1,revision:d.selected.revision});d=await list(admin,period1);await post('payroll-review',{id:d.rows[0].id,revision:d.rows[0].revision,decision:'Approved',note:'Verified updated effective rate and source snapshots',acknowledge:true});d=await list(admin,period1);await post('period-finalize',{id:period1,revision:d.selected.revision,note:'Checked approved net and complete roster'});d=await list(staff,period1);row=d.rows[0];assert.equal(row.status,'Finalized');assert.equal(row.calculationHash,undefined);assert.equal(row.calculation_hash,hash({...row.calculation,calculationHash:''}));
const pdf=await endpoint('payroll','payslip',200,staff,undefined,'?id='+row.id);assert.ok(pdf.subarray(0,5).toString()==='%PDF-');assert.ok((await PDFDocument.load(pdf)).getPageCount()>=1);const csv=await endpoint('payroll','export',200,staff);assert.ok(csv.includes('First verified weekly pay'));assert.ok(!csv.includes('Other employee'));
await assert.rejects(()=>db.prepare("UPDATE payroll SET net_minor=1 WHERE id=?",[row.id]).run(),/immutable/i);await assert.rejects(()=>db.prepare("UPDATE payroll_periods SET label='changed' WHERE id=?",[period1]).run(),/immutable/i);await assert.rejects(()=>db.prepare("DELETE FROM payroll_sources WHERE payroll_id=?",[row.id]).run(),/immutable/i);await post('period-reopen',{id:period1,revision:d.selected.revision,note:'Forbidden silent rewrite'},409);
let payment=await post('payment-record',{id:row.id,amount:(row.net_minor/100).toFixed(2),paidOn:'2026-02-09',method:'Bank transfer',reference:'LOCAL-PAID-1',note:'Confirmed completed transfer'},201);assert.equal((await list(staff,period1)).rows[0].paymentStatus,'Paid');await post('payment-record',{id:row.id,amount:'1',paidOn:'2026-02-09',method:'Bank transfer',reference:'OVERPAY',note:'Must reject'},400);await post('payment-reverse',{id:row.id,payment:payment.id,paidOn:'2026-02-10',reference:'LOCAL-REVERSE-1',note:'Original payment record corrected'},201);assert.equal((await list(staff,period1)).rows[0].paymentStatus,'Ready for payment');await post('payment-reverse',{id:row.id,payment:payment.id,paidOn:'2026-02-10',reference:'LOCAL-REVERSE-2',note:'Must reject duplicate'},409);
console.log('PASS real approved-work calculation, daily overtime, breaks, vacation, bonus approval, effective rate changes, stale-approval rejection, immutable finalized rows, private PDF/CSV and append-only payment reversals');
// Salaried employees may not approve themselves.
const salaryPeriod=(await period('Salaried weekly pay','2026-02-02','2026-02-08',[adminId])).id;await post('calculate',{period:salaryPeriod,employee:adminId});d=await list(admin,salaryPeriod);assert.equal(d.rows[0].gross_cents,106000,'Five years service requires 6% on eligible salary when paid each period');await post('period-submit',{id:salaryPeriod,revision:d.selected.revision});d=await list(admin,salaryPeriod);await post('payroll-review',{id:d.rows[0].id,revision:d.rows[0].revision,decision:'Approved',note:'Self approval rejected',acknowledge:true},403);await post('payroll-review',{id:d.rows[0].id,revision:d.rows[0].revision,decision:'Approved',note:'Independent verified salary review',acknowledge:true},200,hr);
// Duplicate finalized work cannot be paid twice, and unsupported setup cannot yield a false zero.
const duplicate=(await period('Duplicate period','2026-02-02','2026-02-08')).id;await post('calculate',{period:duplicate,employee:staffId},409);
await post('profile-save',{employee:outsider.id,currentId:'',effectiveOn:'2026-01-01',note:'Invalid cross-jurisdiction setup',policy:{...policy,jurisdiction:'CA-ON'}},409);
await post('profile-save',{employee:outsider.id,currentId:'',effectiveOn:'2026-01-01',note:'Invalid contractor deduction bypass',policy:{...policy,taxEngine:'Contractor gross'}},400);
await post('profile-save',{employee:outsider.id,currentId:'',effectiveOn:'2026-01-01',note:'Malformed policy',policy:{...policy,workdays:null}},400);
// A corrected finalized attendance record creates an auditable reconciliation.
const entry=await db.prepare('SELECT * FROM attendance WHERE id=?',[longWork.attendance]).first();const correction=await work('correction-request',{id:entry.id,revision:entry.revision,startsAt:entry.starts_at,endsAt:localInstant('2026-02-04T18:00','America/Edmonton'),breaks:[{kind:'lunch',startsAt:localInstant('2026-02-04T12:00','America/Edmonton'),endsAt:localInstant('2026-02-04T12:30','America/Edmonton')}],note:'Verified prior end-time correction'},201,staff);const cr=await db.prepare('SELECT * FROM corrections WHERE id=?',[correction.id]).first();await work('correction-review',{id:cr.id,revision:cr.revision,decision:'Approved',note:'Verified corrected time'});assert.equal((await list()).reconciliations.length,1);assert.equal((await list(staff,period1)).rows[0].net_minor,row.net_minor,'Historical net cannot change after attendance correction');
console.log('PASS salary and five-year vacation, independent approval, duplicate-work protection, classification/jurisdiction guards and finalized attendance correction reconciliation');
// Workweek boundaries, statutory holidays, explicit unpaid salary leave, and contractor currency rules.
await setupEmployee(outsider.id);
for(const day of ['2026-08-03','2026-08-04','2026-08-05','2026-08-06','2026-08-07','2026-08-08'])await approvedWork(day,'09:00','17:00',outsider.id);
const boundary=(await period('Boundary-week overtime','2026-08-07','2026-08-13',[outsider.id])).id;await post('calculate',{period:boundary,employee:outsider.id});let boundaryRow=(await list(admin,boundary)).rows[0];const boundaryAttendance=await db.prepare("SELECT * FROM attendance WHERE employee_id=? AND starts_at LIKE '2026-08-07%'",[outsider.id]).first();const pendingFix=await work('correction-request',{id:boundaryAttendance.id,revision:boundaryAttendance.revision,startsAt:boundaryAttendance.starts_at,endsAt:boundaryAttendance.ends_at,breaks:[{kind:'lunch',startsAt:localInstant('2026-08-07T12:00','America/Edmonton'),endsAt:localInstant('2026-08-07T12:30','America/Edmonton')}],note:'Verified correction awaits review'},201,outsider);await post('calculate',{period:boundary,employee:outsider.id},409);await work('correction-cancel',{id:pendingFix.id,revision:1},200,outsider);assert.equal(boundaryRow.regular_seconds,14*3600);assert.equal(boundaryRow.overtime_seconds,3600);assert.equal(boundaryRow.gross_cents,48180);
const holidayPeriod=(await period('Holiday-only earnings','2026-02-16','2026-02-22',[outsider.id])).id;await post('calculate',{period:holidayPeriod,employee:outsider.id},409);await post('item-add',{period:holidayPeriod,employee:outsider.id,kind:'Holiday decision',label:'Invalid non-holiday',workDate:'2026-02-17',amount:'240',minutes:480,reference:'Must not accept a non-holiday',eligible:true,regularDay:true,workdaysPastYear:30,importedHistory:true,adjacentAbsenceReviewed:true},400);
const hd=await post('item-add',{period:holidayPeriod,employee:outsider.id,kind:'Holiday decision',label:'Family Day statutory pay',workDate:'2026-02-16',amount:'240',minutes:480,reference:'Verified imported prior employment and ordinary wages',eligible:true,regularDay:true,workdaysPastYear:30,importedHistory:true,adjacentAbsenceReviewed:true},201);await post('item-review',{id:hd.id,revision:1,decision:'Approved',note:'Checked real historical eligibility and wage source'});await post('calculate',{period:holidayPeriod,employee:outsider.id});let holidayRow=(await list(admin,holidayPeriod)).rows[0];assert.equal(holidayRow.gross_cents,24000);assert.equal(holidayRow.holiday_seconds,28800);assert.equal(holidayRow.calculation.vacationAccrued,0);
const unpaidPeriod=(await period('Reviewed salary time off','2026-09-14','2026-09-20',[adminId])).id;const leave=await work('leave-record',{employee:adminId,category:'Personal leave',startsOn:'2026-09-14',endsOn:'2026-09-14',note:'Authorized full-day personal leave'},201,hr);await post('calculate',{period:unpaidPeriod,employee:adminId},409);const un=await post('item-add',{period:unpaidPeriod,employee:adminId,kind:'Unpaid leave',label:'Authorized unpaid personal day',workDate:'2026-09-14',amount:'0',minutes:480,relatedId:leave.id,reference:'Verified unpaid leave classification'},201);await post('item-review',{id:un.id,revision:1,decision:'Approved',note:'Reviewed unpaid classification'},200,hr);await post('calculate',{period:unpaidPeriod,employee:adminId});assert.equal((await list(admin,unpaidPeriod)).rows[0].gross_cents,84800);
const contractor=await person('employee','Independent contractor','PAY-C-'+runId);await db.prepare("UPDATE employees SET employment_type='Contractor' WHERE id=?",[contractor.id]).run();const contractPolicy={...policy,currency:'USD',classification:'Contractor',frequency:'Monthly',taxEngine:'Contractor gross',contractorMethod:'Period fee',overtime:'Verified exemption',exemptionReason:'Verified independent supplier agreement and payment rules',vacationPercent:'0'};await setupEmployee(contractor.id,'1200.50','Period',contractPolicy);const cp=(await period('Monthly contractor payment','2026-10-01','2026-10-31',[contractor.id],'Monthly')).id;await post('calculate',{period:cp,employee:contractor.id});const contractRow=(await list(admin,cp)).rows[0];assert.equal(contractRow.currency,'USD');assert.equal(contractRow.gross_cents,120050);assert.equal(contractRow.deductions_minor,0);assert.equal(contractRow.net_minor,120050);assert.equal(contractRow.calculation.tax.engine,'Contractor gross');
const {periodDates}=await import('../lib/walshken/payroll-access.ts');assert.equal(periodDates({frequency:'Semimonthly',startsOn:'2026-02-16',endsOn:'2026-02-28',payDate:'2026-03-02'}).periods,24);assert.throws(()=>periodDates({frequency:'Monthly',startsOn:'2026-02-02',endsOn:'2026-02-28',payDate:'2026-03-02'}));
const {assignOvertime}=await import('../lib/walshken/payroll-engine.ts');const days=['2026-05-04','2026-05-05','2026-05-06','2026-05-07','2026-05-08'].map(day=>({day,paid:9*3600,regular:9*3600,ot:0,holiday:false,sheet:{status:'Approved'}}));assignOvertime(days,policy);assert.equal(days.reduce((n,d)=>n+d.ot,0),5*3600,'Greater-of daily/weekly overtime must not double count');
console.log('PASS cross-period 44-hour weekly overtime, holiday-only pay and eligibility, explicit unpaid salary leave, real contractor period fees, USD separation and all four period frequencies');
// RLS isolation: simulate a production login locally only.
await db.prepare("GRANT SELECT ON compensation,payroll TO walshken_production_app",[]).run();await db.prepare('CREATE POLICY local_prod_base ON compensation TO walshken_production_app USING(true)',[]).run();await db.prepare('CREATE POLICY local_prod_payroll ON payroll TO walshken_production_app USING(true)',[]).run();await db.prepare('SET ROLE walshken_production_app',[]).run();assert.equal((await db.prepare('SELECT count(*)::int AS n FROM compensation',[]).first()).n,0);assert.equal((await db.prepare('SELECT count(*)::int AS n FROM payroll',[]).first()).n,0);await db.prepare('RESET ROLE',[]).run();
await assert.rejects(()=>db.prepare("UPDATE payroll_payments SET reference='silent' WHERE id=?",[payment.id]).run(),/immutable/i);
writeFileSync('/tmp/walshken-payroll-ui-data.json',JSON.stringify({actor:{id:adminId,name:'Payroll administrator',role:'super_admin',employeeNo:'LOCAL-ADMIN',timeZone:'America/Edmonton'},data:await list(admin,period1)}));
console.log('PASS production-role RLS excludes all preview compensation and payroll; no live database fixtures were created');globalThis.Date=RealDate;process.exit(0);
