import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/workspace/[...parts]/route.ts";
import { createHmac, randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "walshken-route-test-"));
if (process.env.WALSHKEN_TEST_NOTIFICATIONS === "1") {
  mkdirSync(join(sandbox, "drizzle"));
  for (const file of readdirSync("drizzle").filter(name => name.endsWith(".sql"))) copyFileSync(join("drizzle", file), join(sandbox, "drizzle", file));
  writeFileSync(join(sandbox, "drizzle/0010a_notification_stage.sql"), "ALTER TABLE notifications ADD COLUMN release_stage text NOT NULL DEFAULT 'production';");
  copyFileSync("supabase/migrations/20261125075353_notification_email_outbox.sql", join(sandbox, "drizzle/0010b_notification_email.sql"));
} else symlinkSync(join(process.cwd(), "drizzle"), join(sandbox, "drizzle"), "dir");
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
const access=await enroll(staff);
if (process.env.WALSHKEN_TEST_NOTIFICATIONS === "1") {
  globalThis.Date=RealDate;
  const {workspaceDatabase}=await import("../lib/walshken/database.ts");
  const {verifyNotificationEmail}=await import("./verify-notification-email.mjs");
  await verifyNotificationEmail({db:workspaceDatabase(),request,admin,staff,adminId:manager,staffId});
  process.exit(0);
}
await request("session/login",401,staff,{email:staff.email,password:staff.password,mfaCode:access.mfaCode});
await request("employees/edit",200,admin,{...employee,id:staffId,manager,holidayCalendar:"AB",holidayDays:12,
  workSchedule:"Monday to Friday",leaveDays:18,employmentStatus:"On leave"});
await request("employees/edit",200,admin,{...employee,id:manager,manager:"",email:admin.email,employeeNo:"WK-ADMIN",name:"Part B QA Admin"});
await request("payroll/rate",201,admin,{employee:staffId,currency:"CAD",kind:"Hourly",amount:4200,effective:"2024-03-01"});
const profile=await request("view/profile",200,staff);
assert.equal(profile.row.holiday_days,12);
assert.equal(profile.row.work_schedule,"Monday to Friday");
assert.equal(profile.row.employment_status,"On leave");
assert.ok(profile.row.first_login_at>profile.row.activated_at);
assert.notEqual(profile.row.hire_date,profile.row.first_login_at.slice(0,10));
assert.deepEqual(profile.compensation,{kind:"Hourly",amount_cents:4200,currency:"CAD",effective_on:"2024-03-01"});
await request("view/employees",403,staff);
await request("view/payroll",403,staff);
await request("payroll/rate",403,staff,{employee:staffId,amount:3000});
assert.equal((await request("view/profile",200,admin)).compensation,null);
console.log("PASS mandatory MFA, role enforcement, admin and employee profile edits, private effective-dated salary");
await request("profile/contact",401,null,{phone:"+1 403 555 0130"});
await request("profile/contact",400,staff,{phone:"phone me"});
await request("profile/contact",200,staff,{phone:"+1 403 555 0130",role:"super_admin"});
const staffContact=(await request("view/profile",200,staff)).row;
assert.equal(staffContact.phone,"+1 403 555 0130");
assert.equal(staffContact.role,"employee");
assert.notEqual((await request("view/profile",200,admin)).row.phone,staffContact.phone);
await request("profile/contact",200,staff,{phone:""});
assert.equal((await request("view/profile",200,staff)).row.phone,null);
console.log("PASS authenticated staff can edit only their own contact number");


const imageBytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSioAAAAASUVORK5CYII=","base64");
const photo=new FormData();
photo.append("photo",new Blob([imageBytes],{type:"image/png"}),"avatar.png");
await request("profile/photo",200,staff,photo);
assert.deepEqual(await request("profile/photo",200,staff),imageBytes);
await request("profile/photo",404,admin);
await request("profile/remove-photo",200,staff,{});
await request("profile/photo",404,staff);
const oldSession={...staff};
offset+=301_000;
const resetPassword=secret();
assert.equal((await request("session/recover",200,staff,{email:staff.email,code:access.recoveryCodes[0],password:resetPassword})).signInRequired,true);
await request("view/profile",401,oldSession);
await request("session/recover",403,staff,{email:staff.email,code:access.recoveryCodes[0],password:secret()});
staff.password=resetPassword;
await request("session/login",200,staff,{email:staff.email,password:staff.password,mfaCode:access.recoveryCodes[1]});
console.log("PASS photo privacy, unused credential recovery, replay rejection and old-session revocation");

const adminReset=await request("employees/invite",200,admin,{id:staffId});
const staffOld={...staff};
const nextPassword=secret();
offset+=301_000;
const result=await request("session/activate",200,staff,{email:staff.email,code:adminReset.code,password:nextPassword});
assert.equal(result.signInRequired,true);
await request("view/profile",401,staffOld);
staff.password=nextPassword;
await request("session/login",200,staff,{email:staff.email,password:staff.password,mfaCode:access.recoveryCodes[2]});
await request("employees/status",200,admin,{id:staffId,status:"Suspended"});
await request("view/profile",401,staff);
await request("employees/status",200,admin,{id:staffId,status:"Active"});
await request("session/login",200,staff,{email:staff.email,password:staff.password,mfaCode:access.recoveryCodes[3]});
await request("employees/edit",200,admin,{...employee,id:staffId,employmentStatus:"Ended",employmentEnd:"2026-11-22"});
await request("view/profile",401,staff);
await request("employees/status",409,admin,{id:staffId,status:"Active"});
const preExpiryOffset=offset;
offset+=12*3_600_000+1000;
await request("view/profile",401,admin);
offset=preExpiryOffset;
console.log("PASS administrator reset, suspension, end of employment and 12-hour session expiration");

const begin=performance.now();
for(let i=0;i<100;i++){
  await request("employees/add",201,admin,{...employee,employeeNo:"TEST-"+i,email:`qa-${i}@walshken.test`,name:"QA Staff "+i});
}
const firstPage=await request("view/employees?page=1",200,admin);
const lastPage=await request("view/employees?page=4",200,admin);
assert.deepEqual(firstPage.registry,{query:"",page:1,pages:4,total:102});
assert.equal(lastPage.rows.length,12);
assert.equal((await request("view/employees?q=TEST-97",200,admin)).rows[0].employee_no,"TEST-97");
console.log("PASS 100 additional employee records with scoped search and four pages in "+Math.round(performance.now()-begin)+" ms");

const assignedRoles=[
  ["admin","view/employees","view/payroll"],
  ["hr","view/payroll","view/integrations"],
  ["manager","view/approvals","view/payroll"],
  ["employee","view/tasks","view/roles"],
  ["guest","view/documents","view/directory"],
];
for(const [role,allowed,denied] of assignedRoles){
  const account={email:`role-${role}@walshken.test`,password:secret(),cookie:""};
  const assigned={...employee,email:account.email,employeeNo:`ROLE-${role}`,name:`QA ${role}`,role};
  const invitation=await request("employees/add",201,admin,assigned);
  await request("session/activate",200,account,{email:account.email,password:account.password,code:invitation.code});
  await request("session/login",200,account,{email:account.email,password:account.password});
  await request(allowed,403,account);
  await enroll(account);
  assert.equal((await request("view/profile",200,account)).row.role,role);
  await request(allowed,200,account);
  await request(denied,403,account);
  if(role==="guest")await request("notifications/read",200,account,{});
  if(role==="employee"){
    const registry=await request("view/employees?q=ROLE-employee",200,admin);
    const id=registry.rows[0].id;
    const outdatedInvite=await request("employees/invite",200,admin,{id});
    const newEmail="changed-employee@walshken.test";
    await request("employees/edit",200,admin,{...assigned,email:newEmail,id});
    await request("view/profile",401,account);
    await request("session/login",401,account,{email:account.email,password:account.password});
    await request("session/activate",403,account,{email:newEmail,code:outdatedInvite.code,password:secret()});
  }
}
console.log("PASS all six roles using issued activation codes, MFA, role authorization, and sign-in email change");

const newAuthenticator=await request("mfa/setup",200,admin,{password:admin.password,code:adminMfa.recoveryCodes[0]});
const existingFactorSession={...admin,cookie:""};
await request("session/login",200,existingFactorSession,{email:admin.email,password:admin.password,mfaCode:adminMfa.recoveryCodes[1]});
fixedTime=Date.now();
const rotated=await request("mfa/confirm",200,admin,{password:admin.password,code:authenticatorCode(newAuthenticator.setupKey,-1)});
assert.equal(rotated.recoveryCodes.length,8);
await request("view/profile",401,existingFactorSession);
await request("session/login",401,admin,{email:admin.email,password:admin.password,mfaCode:adminMfa.recoveryCodes[2]});
await request("session/login",200,admin,{email:admin.email,password:admin.password,mfaCode:authenticatorCode(newAuthenticator.setupKey,0)});
fixedTime=null;
console.log("PASS authenticator replacement keeps the existing factor until confirmation and invalidates previous sessions and codes");


globalThis.Date=RealDate;
process.exit(0);
