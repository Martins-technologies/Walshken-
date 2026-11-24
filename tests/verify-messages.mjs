import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/workspace/[...parts]/route.ts";
import { createHmac, randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "walshken-route-test-"));
symlinkSync(join(process.cwd(), "drizzle"), join(sandbox, "drizzle"), "dir");
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
let offset=0;
class TestDate extends RealDate {
  constructor(...args){super(...(args.length?args:[RealDate.now()+offset]));}
  static now(){return RealDate.now()+offset;}
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
const {id:direct}=await request("messages/create",201,admin,{kind:"Direct",members:employeeRecord.id});
assert.equal((await request("messages/create",200,admin,{kind:"Direct",members:employeeRecord.id})).id,direct);
const {id:message}=await request("messages/send",201,staff,{conversation:direct,body:"Private review",mention:managerId()});
function managerId(){return (adminId??"");}
const thread=await request("conversation/"+direct,200,admin);
assert.match(thread.rows[0].body,/^@.* Private review$/);
await request("messages/read",200,admin,{conversation:direct,through:message});
const staffThread=await request("conversation/"+direct,200,staff);
assert.ok(staffThread.members.find(member=>member.id===adminId).last_read_at);
await request("conversation/"+direct,404,guest);
await request("messages/create",403,guest,{kind:"Direct",members:employeeRecord.id});
assert.ok((await request("view/notifications",200,admin)).rows.some(row=>row.title==="Mentioned in a conversation"));
const {id:reply}=await request("messages/send",201,admin,{conversation:direct,body:"Ready",reply:message});
await request("messages/edit",200,staff,{conversation:direct,id:message,body:"Private review updated"});
await request("messages/reaction",200,admin,{conversation:direct,id:message,emoji:"🎉"});
await request("messages/pin",200,admin,{conversation:direct,id:message,pinned:"1"});
const search=await request("conversation/"+direct+"?q=Ready",200,staff);
assert.equal(search.rows[0].reply_body,"Private review updated");
assert.equal(search.rows[0].id,reply);
const latest=await request("conversation/"+direct,200,staff);
assert.ok(latest.rows.find(row=>row.id===message&&row.reactions==="🎉"&&row.pinned===1));
await request("messages/archive",200,staff,{conversation:direct,archived:"1"});
assert.equal((await request("view/messages",200,staff)).rows.find(row=>row.id===direct).archived,1);
assert.equal((await request("messages/create",200,staff,{kind:"Direct",members:[adminId]})).id,direct);
assert.equal((await request("view/messages",200,staff)).rows.find(row=>row.id===direct).archived,0);
const policy={creation:"All staff",approval:"1",members:"Owners",forwarding:"All staff",external:"1",messageChanges:"Sender",retentionDays:30};
await request("communication-policy/save",403,staff,policy);
await request("communication-policy/save",200,admin,policy);
await request("messages/create",403,staff,{kind:"Company",title:"Company",members:adminId});
await request("messages/create",403,staff,{kind:"Country",title:"Other country",country:"GB",members:[adminId]});
await request("messages/create",201,staff,{kind:"Temporary",title:"Review group",closesAt:new Date(Date.now()+3600000).toISOString(),members:[adminId]});
const pending=(await request("view/messages",200,admin)).pendingGroups.find(row=>row.title==="Review group").id;
await request("conversation/"+pending,404,staff);
await request("messages/review",403,staff,{conversation:pending,status:"Active"});
await request("messages/review",200,admin,{conversation:pending,status:"Active"});
await request("messages/forward",201,staff,{conversation:direct,destination:pending,id:message});
assert.equal((await request("conversation/"+pending,200,admin)).rows[0].forwarded,1);
const {id:external}=await request("messages/create",201,admin,{kind:"External",title:"Guest support",members:[guestId,employeeRecord.id]});
await request("messages/forward",403,staff,{conversation:direct,destination:external,id:message});
await request("messages/send",201,guest,{conversation:external,body:"Guest response"});
assert.ok((await request("conversation/"+external,200,admin)).rows.some(row=>row.body==="Guest response"));
await request("messages/member",403,staff,{conversation:external,operation:"remove",employee:guestId});
await request("messages/member",200,admin,{conversation:external,operation:"remove",employee:guestId});
await request("conversation/"+external,404,guest);
await request("messages/member",200,admin,{conversation:external,operation:"add",employee:guestId});
await request("communication-policy/save",200,admin,{...policy,external:"0",messageChanges:"Locked"});
await request("conversation/"+external,404,guest);
await request("messages/edit",403,staff,{conversation:direct,id:message,body:"Locked"});
await db.prepare("UPDATE messages SET created_at=? WHERE id=?",[new Date(Date.now()-31*86400000).toISOString(),message]).run();
assert.ok(!(await request("conversation/"+direct+"?q=Private",200,admin)).rows.length);
await request("communication-policy/apply-retention",400,admin,{});
await request("communication-policy/apply-retention",200,admin,{confirmation:"ERASE"});
await request("communication-policy/save",200,admin,{...policy,retentionDays:0,external:"0"});
const afterRetention=await request("conversation/"+direct,200,admin);
assert.equal(afterRetention.rows.find(row=>row.id===message).body,"");
assert.equal(afterRetention.rows.find(row=>row.id===reply).reply_body,null);
for(let index=0;index<58;index++){
  await db.prepare("INSERT INTO messages (id,conversation_id,sender_id,body) VALUES (?,?,?,?)",["history-"+index,direct,adminId,"Archive page "+index]).run();
}
const head=await request("conversation/"+direct+"?q=Archive",200,admin);
assert.equal(head.rows.length,50);
assert.ok(head.next);
const tail=await request("conversation/"+direct+"?q=Archive&before="+encodeURIComponent(head.next),200,admin);
assert.equal(tail.rows.length,8);
assert.equal(new Set([...head.rows,...tail.rows].map(row=>row.id)).size,58);
// Refreshing the exact earlier page must reflect edits and deletion by the other participant.
const earlierMessage=tail.rows[0];
await request("messages/edit",200,admin,{conversation:direct,id:earlierMessage.id,body:"Updated on the earlier page"});
let earlierAgain=await request("conversation/"+direct+"?before="+encodeURIComponent(head.next),200,staff);
assert.equal(earlierAgain.rows.find(row=>row.id===earlierMessage.id).body,"Updated on the earlier page");
await request("messages/delete",200,admin,{conversation:direct,id:earlierMessage.id});
earlierAgain=await request("conversation/"+direct+"?before="+encodeURIComponent(head.next),200,staff);
assert.equal(earlierAgain.rows.find(row=>row.id===earlierMessage.id).body,"");
assert.ok(earlierAgain.rows.find(row=>row.id===earlierMessage.id).deleted_at);
const pinTarget=head.rows[3].id;
await request("messages/pin",200,admin,{conversation:direct,id:pinTarget,pinned:"1"});
assert.deepEqual((await request("conversation/"+direct+"?pinned=1",200,staff)).rows.map(row=>row.id),[pinTarget]);
const inline=await request("messages/send",201,staff,{conversation:direct,body:"@Part B QA Admin Please confirm this.",mentions:[adminId]});
assert.equal((await request("conversation/"+direct,200,admin)).rows.at(-1).body,"@Part B QA Admin Please confirm this.");
await request("messages/send",400,staff,{conversation:direct,body:"Unrelated text",mentions:[adminId]});
const beforeNotifications=(await request("view/notifications",200,admin)).rows.filter(row=>row.title==="Mentioned in a conversation").length;
assert.ok(beforeNotifications>=2);
// A regular administrator can configure communication and review permitted groups.
const scopedAdmin={email:"scoped-admin@walshken.test",password:secret(),cookie:""};
const scopedInvite=await request("employees/add",201,admin,{...employee,name:"Scoped Administrator",email:scopedAdmin.email,employeeNo:"QA-SCOPED-ADMIN",role:"admin"});
await request("session/activate",200,scopedAdmin,{...scopedAdmin,code:scopedInvite.code});
await request("session/login",200,scopedAdmin,scopedAdmin);
await enroll(scopedAdmin);
await request("communication-policy/save",200,scopedAdmin,policy);
assert.ok((await request("view/messages",200,scopedAdmin)).communicationPolicy);
const requestTitle="Scoped team request";
await request("messages/create",201,staff,{kind:"Group",title:requestTitle,members:[adminId]});
const approval=(await request("view/messages",200,scopedAdmin)).pendingGroups.find(row=>row.title===requestTitle);
assert.ok(approval);
await request("messages/review",200,scopedAdmin,{conversation:approval.id,status:"Active"});

// Verify every channel kind uses its real scope, and changes revoke old access.
const scopedAdminId=(await request("view/employees",200,admin)).rows.find(row=>row.email===scopedAdmin.email).id;
await db.prepare("UPDATE employees SET country='CA',jurisdiction='CA-AB' WHERE id=?",[adminId]).run();
await request("communication-policy/save",200,admin,{...policy,approval:"0"});
const kinds=[
 {kind:"Company",title:"Company review"},
 {kind:"Department",title:"Operations review",department},
 {kind:"Country",title:"Canada review",country:"CA"},
 {kind:"Private",title:"Management review",members:[scopedAdminId]},
];
for(const type of kinds){
 const {id:channel}=await request("messages/create",201,admin,{...type,members:type.members??[employeeRecord.id]});
 await request("conversation/"+channel,200,type.kind==="Private"?scopedAdmin:staff);
 if(type.kind==="Private")await request("messages/member",403,admin,{conversation:channel,operation:"add",employee:employeeRecord.id});
 if(type.kind==="Department"){
   await db.prepare("UPDATE employees SET department_id=NULL WHERE id=?",[employeeRecord.id]).run();
   await request("conversation/"+channel,404,staff);
   await db.prepare("UPDATE employees SET department_id=? WHERE id=?",[department,employeeRecord.id]).run();
 }
 if(type.kind==="Country"){
   await db.prepare("UPDATE employees SET country='GB' WHERE id=?",[employeeRecord.id]).run();
   await request("conversation/"+channel,404,staff);
   await db.prepare("UPDATE employees SET country='CA' WHERE id=?",[employeeRecord.id]).run();
 }
}
await db.prepare("INSERT INTO projects (id,org_id,owner_id,department_id,name,description) VALUES ('communication-project','walshken',?,?,?,'Communication scope verification')",[adminId,department,"Project review"]).run();
const projectChannel=await request("messages/create",201,admin,{kind:"Project",title:"Project channel",project:"communication-project",members:[employeeRecord.id]});
await request("conversation/"+projectChannel.id,200,staff);
await db.prepare("UPDATE employees SET department_id=NULL WHERE id=?",[employeeRecord.id]).run();
await request("conversation/"+projectChannel.id,404,staff);
await db.prepare("UPDATE employees SET department_id=? WHERE id=?",[department,employeeRecord.id]).run();
const {id:scopedDirect}=await request("messages/create",201,staff,{kind:"Direct",members:[scopedAdminId]});
await request("messages/send",201,staff,{conversation:scopedDirect,body:"Current department teammate"});
await db.prepare("UPDATE employees SET department_id=NULL WHERE id=?",[scopedAdminId]).run();
await request("messages/send",403,staff,{conversation:scopedDirect,body:"No longer in scope"});
await request("messages/send",403,scopedAdmin,{conversation:scopedDirect,body:"No longer in scope"});
assert.equal((await request("conversation/"+scopedDirect,200,staff)).rows.length,1);
await db.prepare("UPDATE employees SET department_id=? WHERE id=?",[department,scopedAdminId]).run();
const groupMessage=await request("messages/send",201,staff,{conversation:approval.id,body:"Retain this history"});
await request("messages/remove-group",404,scopedAdmin,{conversation:approval.id});
await request("messages/remove-group",404,staff,{conversation:scopedDirect});
await request("messages/remove-group",200,staff,{conversation:approval.id});
await request("conversation/"+approval.id,404,admin);
await request("messages/send",404,staff,{conversation:approval.id,body:"Closed group"});
assert.ok((await request("view/messages",200,staff)).removedGroups.some(row=>row.id===approval.id));
assert.ok(!(await request("view/messages",200,scopedAdmin)).removedGroups.some(row=>row.id===approval.id));
await request("messages/restore-group",404,scopedAdmin,{conversation:approval.id});
await request("messages/restore-group",200,admin,{conversation:approval.id});
assert.ok((await request("conversation/"+approval.id,200,staff)).rows.some(row=>row.id===groupMessage.id));
console.log("PASS group owner removal, Super Admin restoration, retained history and access controls");
console.log("PASS archived direct conversation reopening and preventing new messages after peer scope changes");
console.log("PASS company, department, project, country and management group scopes, with immediate revocation when assignments change");
console.log("PASS earlier-history edits and removal refresh, pinned-only search, inline mentions, regular administrator policy and scoped approvals");
console.log("PASS messaging, scoped groups, membership controls, approvals, logged changes, guest access and revocation, replies, forwarding, mentions, read receipts, reactions, pins, archiving, retention and paginated search");
