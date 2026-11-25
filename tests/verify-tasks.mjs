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

process.env.WALSHKEN_DOCUMENTS_ENABLED="1";
process.env.WALSHKEN_RELEASE_SCOPE="staff-documents";
process.env.WALSHKEN_DOCUMENT_STORAGE_ID="document-storage-review";
const {readFileSync}=await import('node:fs');

const {GET:documentGet,POST:documentPost}=await import('../app/api/documents/[action]/route.ts');
const {encryptSettings}=await import('../lib/walshken/server.ts');
const {createCanvas}=await import('@napi-rs/canvas');
const {default:ExcelJS}=await import('exceljs');
const {default:JSZip}=await import('jszip');
const objects=new Map();
globalThis.fetch=async(input,options)=>{
 const req=input instanceof Request?input:new Request(input,options);
 const url=new URL(req.url);assert.equal(url.hostname,'ssggjxyexwkshtcypsaq.storage.supabase.co');
 const key=decodeURIComponent(url.pathname),method=req.method;
 if(method==='PUT'){objects.set(key,Buffer.from(await req.arrayBuffer()));return new Response(null,{status:200});}
 if(method==='GET'){const bytes=objects.get(key);return bytes?new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length)}}):new Response('',{status:404});}
 if(method==='DELETE'){objects.delete(key);return new Response(null,{status:204});}
 throw Error('Unexpected storage request '+method);
};
const settings={endpoint:'https://ssggjxyexwkshtcypsaq.storage.supabase.co/storage/v1/s3',region:'us-west-2',bucket:'walshken-documents-review',accessKey:'local-test',secretKey:secret()};
await db.prepare("INSERT INTO integrations(id,configuration,enabled,updated_at) VALUES(?,?,1,?)",['document-storage-review',await encryptSettings('document-storage-review',settings),new Date().toISOString()]).run();
async function documentRequest(action,status,user=admin,body,query=''){
 const req=new Request(origin+'/api/documents/'+action+query,{method:body===undefined?'GET':'POST',headers:{origin,...(user?.cookie?{cookie:user.cookie}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});
 const result=await(body===undefined?documentGet:documentPost)(req,{params:Promise.resolve({action})});
 const type=result.headers.get('content-type')??'';const data=type.includes('json')?await result.json():type.includes('text/')?await result.text():Buffer.from(await result.arrayBuffer());
 assert.equal(result.status,status,`${action}${query.slice(0,20)} expected ${status}, got ${result.status}: ${data?.error??''}`);return {data,headers:result.headers};
}
const post=async(action,data,status=200,user=admin)=>(await documentRequest(action,status,user,data)).data;
const list=async(user=admin)=>(await documentRequest('list',200,user)).data;
const rule=async(scope,target,principalType,principalId,permissions,effect='allow',user=admin)=>post('rule-add',{scope,target,principalType,principalId,permissions,effect},200,user);
const file=(name,bytes,extra={})=>{const data=new FormData();data.set('file',new File([bytes],name));for(const[key,value]of Object.entries(extra))data.set(key,String(value));return data;};
const canvas=createCanvas(500,250),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,500,250);ctx.fillStyle='#143b78';ctx.fillRect(30,30,100,100);const png=canvas.toBuffer('image/png');

process.env.WALSHKEN_TASKS_ENABLED='1';
process.env.WALSHKEN_TASK_DATASET='preview';
process.env.WALSHKEN_TASK_BUCKET='walshken-task-files-review';
process.env.WALSHKEN_RELEASE_SCOPE='staff-tasks';
const {GET:taskGet,POST:taskPost}=await import('../app/api/tasks/[action]/route.ts');
const {localDate}=await import('../lib/walshken/work.ts');
async function taskRequest(action,status,user=admin,body,query=''){
 const req=new Request(origin+'/api/tasks/'+action+query,{method:body===undefined?'GET':'POST',headers:{origin,...(user?.cookie?{cookie:user.cookie}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});
 const response=await(body===undefined?taskGet:taskPost)(req,{params:Promise.resolve({action})});const type=response.headers.get('content-type')??'',result=type.includes('json')?await response.json():Buffer.from(await response.arrayBuffer());
 assert.equal(response.status,status,`${action} expected ${status}, got ${response.status}: ${result?.error??''}`);return {data:result,headers:response.headers};
}
const taskPostData=async(action,data,status=200,user=admin)=>(await taskRequest(action,status,user,data)).data;
const dashboard=async(user=admin,query='')=>(await taskRequest('list',200,user,undefined,query)).data;
const taskInfo=async(id,user=admin)=>taskPostData('detail',{id},200,user);
const revision=async(id,user=admin)=>(await taskInfo(id,user)).row.revision;
const mutable=async(action,id,data={},status=200,user=admin)=>taskPostData(action,{id,revision:await revision(id,user),...data},status,user);
await db.prepare('CREATE SCHEMA IF NOT EXISTS walshken_private',[]).run();
const jobSource=readFileSync(join(repository,'ops/tasks-preview-maintenance.sql'),'utf8');const jobDefinition=jobSource.slice(jobSource.indexOf('CREATE OR REPLACE FUNCTION'),jobSource.indexOf('REVOKE ALL ON FUNCTION'));
await db.prepare(jobDefinition,[]).run();
const maintain=async()=> (await db.prepare('SELECT walshken_private.task_review_maintenance() AS result',[]).first()).result;
await taskRequest('list',401,null);await taskRequest('list',403,guest);
await taskPostData('assign',{},403,staff);
await request('tasks/add',404,admin,{});await request('task-comments/unknown',404,admin);
const managerUser={email:`manager-${runId}@walshken.test`,password:secret(),cookie:''};
const managerRecord={...employee,name:'Task QA Manager',email:managerUser.email,employeeNo:'TASK-M-'+runId,role:'manager'};
const managerInvite=await request('employees/add',201,admin,managerRecord);await request('session/activate',200,managerUser,{email:managerUser.email,password:managerUser.password,code:managerInvite.code});await request('session/login',200,managerUser,managerUser);await enroll(managerUser);
const managerId=(await request('view/employees',200,admin)).rows.find(r=>r.email===managerUser.email).id;
await db.prepare('UPDATE employees SET manager_id=? WHERE id=?',[managerId,staffId]).run();
const outsider={email:`outside-${runId}@walshken.test`,password:secret(),cookie:''};
const outsiderInvite=await request('employees/add',201,admin,{...employee,name:'Other employee',email:outsider.email,employeeNo:'TASK-OUT-'+runId});await request('session/activate',200,outsider,{email:outsider.email,password:outsider.password,code:outsiderInvite.code});await request('session/login',200,outsider,outsider);await enroll(outsider);
const outsiderId=(await request('view/employees',200,admin)).rows.find(r=>r.email===outsider.email).id;
await request('projects/add',201,admin,{name:'Authorized QA project',description:'Project reference'});
const project=(await request('view/projects',200,admin)).rows.find(p=>p.name==='Authorized QA project').id;
const today=localDate(new Date().toISOString(),'America/Edmonton');const day=(offset)=>{const date=new RealDate(today+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10);};
const assignment={employee:staffId,reviewer:managerId,title:'Prepare customer handover',description:'Complete the client handover and attach supporting work.',priority:'High',startDate:today,dueDate:day(2),estimatedHours:2.5,project,clientReference:'CLIENT-PRIVATE-QA'};
const taskId=(await taskPostData('assign',assignment,201)).id;
let detail=await taskInfo(taskId,staff);
assert.equal(detail.row.title,assignment.title);assert.equal(detail.row.description,assignment.description);assert.equal(detail.row.employee_id,staffId);assert.equal(detail.row.department_id,department);assert.equal(detail.row.assigned_by,adminId);assert.equal(detail.row.reviewer_id,managerId);assert.equal(detail.row.estimate_minutes,150);assert.equal(detail.row.approval_status,'Not submitted');assert.equal(detail.row.client_reference,assignment.clientReference);assert.ok(detail.row.created_at);assert.equal(detail.row.project_id,project);assert.equal(detail.row.completed_at,null);
await taskPostData('detail',{id:taskId},404,outsider);assert.equal((await dashboard(outsider)).registry.total,0);assert.ok((await dashboard(managerUser,'?team=1')).rows.some(t=>t.id===taskId));assert.equal((await dashboard(managerUser)).registry.total,0);
await taskPostData('assign',{...assignment,employee:outsiderId},403,managerUser);
await taskPostData('assign',{...assignment,reviewer:staffId},400);
await taskPostData('assign',{...assignment,project:'other-org-project'},403);
await taskPostData('assign',{...assignment,startDate:day(3),dueDate:day(1)},400);
await taskPostData('assign',{...assignment,estimatedHours:-2},400);
await mutable('progress',taskId,{status:'Completed',progress:100},400,staff);
await mutable('progress',taskId,{status:'In Progress',progress:25},200,staff);
const stale=await revision(taskId,staff);await mutable('progress',taskId,{status:'On Hold',progress:30},200,staff);await taskPostData('progress',{id:taskId,revision:stale,status:'In Progress',progress:35},409,staff);
await mutable('progress',taskId,{status:'In Progress',progress:35},200,staff);
console.log('PASS all assignment fields, individual/team views, current manager scope, project authorization, statuses and stale-update protection');

await taskPostData('time-add',{id:taskId,minutes:90,workedOn:today,note:'Drafted handover'},200,staff);
assert.equal((await taskInfo(taskId,staff)).actualSeconds,5400);
await taskPostData('time-add',{id:taskId,minutes:30,workedOn:day(1),note:'Future work'},400,staff);
await taskPostData('time-add',{id:taskId,minutes:30,workedOn:today,note:'No access'},404,outsider);
await taskPostData('timer-start',{id:taskId},200,staff);await taskPostData('timer-start',{id:taskId},409,staff);
offset+=125000;
let running=await dashboard(staff);assert.equal(running.running.task_id,taskId);assert.ok(running.rows.find(t=>t.id===taskId).actual_seconds>=5525);
await taskPostData('timer-stop',{id:taskId},200,staff);detail=await taskInfo(taskId,staff);assert.equal(detail.actualSeconds,5525);assert.equal((await dashboard(staff)).running,null);
const manual=detail.time.find(row=>row.kind==='Manual');await taskPostData('time-void',{id:taskId,entry:manual.id,note:'Correcting an accidental entry'},200,staff);assert.equal((await taskInfo(taskId,staff)).actualSeconds,125);assert.ok((await taskInfo(taskId,staff)).time.some(row=>row.id===manual.id&&row.voided_at));
await taskPostData('comment',{id:taskId,body:'First real progress note'},201,staff);await taskPostData('comment',{id:taskId,body:'Reviewed the draft'},201,managerUser);assert.equal((await taskInfo(taskId,staff)).notes.length,2);assert.ok((await request('view/notifications',200,managerUser)).rows.some(n=>n.title==='Task discussion updated'));
console.log('PASS manual logs, persistent timer, one active timer, actual-hour totals, retained corrections, discussion and real notifications');

const supporting=await taskPostData('upload',file('support.png',png,{id:taskId,revision:await revision(taskId,staff)}),201,staff);
let fileAccess=await taskPostData('file-access',{id:taskId,file:supporting.id},200,staff);
const image=await taskRequest('file',200,staff,undefined,'?token='+encodeURIComponent(fileAccess.token));assert.equal(image.headers.get('content-type'),'image/jpeg');assert.match(image.headers.get('cache-control'),/no-store/);assert.notDeepEqual(image.data,png);
await taskRequest('file',403,managerUser,undefined,'?token='+encodeURIComponent(fileAccess.token));await taskRequest('file',401,staff,undefined,'?token='+encodeURIComponent(fileAccess.token+'tampered'));await taskPostData('file-access',{id:taskId,file:supporting.id},404,outsider);
await taskPostData('upload',file('bad.svg',Buffer.from('<svg/>'),{id:taskId,revision:await revision(taskId,staff)}),400,staff);
const libraryDoc=(await post('upload',file('library.png',png),201)).id;
await taskPostData('document-link',{id:taskId,document:libraryDoc},403,staff);
await rule('document',libraryDoc,'employee',staffId,['view']);await taskPostData('document-link',{id:taskId,document:libraryDoc},200,staff);assert.equal((await taskInfo(taskId,staff)).documents[0].available,true);
await rule('document',libraryDoc,'employee',staffId,['view'],'deny');detail=await taskInfo(taskId,staff);assert.equal(detail.documents[0].available,false);assert.equal(detail.documents[0].name,undefined);
await taskPostData('document-unlink',{id:taskId,link:detail.documents[0].id},200,staff);assert.equal((await taskInfo(taskId,staff)).documents.length,0);
console.log('PASS private supporting uploads, watermarked raster previews, session-bound tokens, unauthorized access rejection and linked-document ACL revocation');

await taskPostData('timer-start',{id:taskId},200,staff);offset+=60000;
await mutable('submit',taskId,{note:'Handover draft and supporting evidence complete.'},200,staff);
detail=await taskInfo(taskId,staff);assert.equal(detail.row.status,'Waiting for Review');assert.equal(detail.row.approval_status,'Pending');assert.equal(detail.row.progress,100);assert.ok(detail.row.submitted_at);assert.equal((await dashboard(staff)).running,null);
await taskPostData('time-add',{id:taskId,minutes:10,workedOn:today,note:'Locked work'},409,staff);await taskPostData('upload',file('locked.png',png,{id:taskId,revision:detail.row.revision}),409,staff);await mutable('progress',taskId,{status:'In Progress',progress:95},409,staff);
await mutable('review',taskId,{decision:'Approved'},403,staff);await mutable('review',taskId,{decision:'Changes requested',note:''},400,managerUser);
await mutable('review',taskId,{decision:'Changes requested',note:'Add a final checklist.'},200,managerUser);detail=await taskInfo(taskId,staff);assert.equal(detail.row.status,'In Progress');assert.equal(detail.row.approval_status,'Changes requested');assert.equal(detail.row.completed_at,null);
await mutable('submit',taskId,{note:'Checklist updated.'},200,staff);await mutable('review',taskId,{decision:'Approved',note:'Complete and verified.'},200,managerUser);detail=await taskInfo(taskId,staff);assert.equal(detail.row.status,'Completed');assert.equal(detail.row.approval_status,'Approved');assert.ok(detail.row.completed_at);assert.ok(detail.reviews.some(r=>r.decision==='Changes requested'));assert.ok(detail.reviews.some(r=>r.decision==='Approved'));
await mutable('progress',taskId,{status:'In Progress',progress:30},409,staff);await mutable('reopen',taskId,{note:'Client requested an additional update.'},200,managerUser);assert.equal((await taskInfo(taskId,staff)).row.approval_status,'Not submitted');assert.equal((await taskInfo(taskId,staff)).row.completed_at,null);
await mutable('cancel',taskId,{note:'Work no longer required.'},200,managerUser);assert.equal((await taskInfo(taskId,staff)).row.status,'Cancelled');await mutable('reopen',taskId,{note:'Resume work.'},200,managerUser);
await taskPostData('file-remove',{id:taskId,file:supporting.id},200,staff);await taskRequest('file',404,staff,undefined,'?token='+encodeURIComponent(fileAccess.token));
console.log('PASS submission lock, return for changes, approval, completion timestamps, cancellation/reopen, immutable review history and file revocation');

// Assignment changes immediately invalidate a former employee and former manager.
const managerAssignment={...assignment,project:'',reviewer:adminId};
const managed=(await taskPostData('assign',managerAssignment,201,managerUser)).id;
await taskPostData('upload',file('assignment.png',png,{id:managed,revision:await revision(managed,staff)}),201,staff);
const evidence=(await taskInfo(managed,staff)).files[0],oldTicket=await taskPostData('file-access',{id:managed,file:evidence.id},200,staff);
await mutable('edit',managed,{...managerAssignment,employee:outsiderId},200,admin);
await taskPostData('detail',{id:managed},404,staff);await taskRequest('file',404,staff,undefined,'?token='+encodeURIComponent(oldTicket.token));await taskPostData('detail',{id:managed},404,managerUser);assert.equal((await taskInfo(managed,outsider)).row.employee_id,outsiderId);
await db.prepare('UPDATE employees SET manager_id=NULL WHERE id=?',[staffId]).run();await taskPostData('detail',{id:taskId},404,managerUser);await db.prepare('UPDATE employees SET manager_id=? WHERE id=?',[managerId,staffId]).run();
console.log('PASS employee reassignment and reporting-manager changes revoke task and supporting-file access immediately');

const overdue=(await taskPostData('assign',{...assignment,title:'Overdue work',project:'',startDate:day(-4),dueDate:day(-2)},201)).id;
const future=(await taskPostData('assign',{...assignment,title:'Upcoming deadline',project:'',startDate:day(1),dueDate:day(5)},201)).id;
let overview=await dashboard(staff);assert.ok(overview.stats.overdue>=1);assert.ok(overview.stats.upcoming>=1);assert.ok(overview.stats.today>=1);assert.ok((await dashboard(staff,'?bucket=overdue')).rows.some(t=>t.id===overdue));assert.ok((await dashboard(staff,'?bucket=upcoming')).rows.some(t=>t.id===future));assert.ok((await dashboard(staff,'?q=Upcoming')).rows.every(t=>t.title.includes('Upcoming')));
const first=await maintain();assert.ok(first.alerts>=2);const second=await maintain();assert.equal(second.alerts,0);
assert.ok((await request('view/notifications',200,managerUser)).rows.some(n=>n.title==='Task overdue'));assert.ok((await request('view/notifications',200,staff)).rows.some(n=>n.title==='Task overdue'));
const alertRows=(await db.prepare('SELECT * FROM task_overdue_alerts WHERE task_id=?',[overdue]).all()).results;assert.ok(alertRows.some(row=>row.employee_id===managerId));assert.ok(!alertRows.some(row=>row.employee_id===outsiderId));
await mutable('cancel',overdue,{note:'Stop overdue reminders.'},200,admin);assert.equal((await maintain()).alerts,0);
await taskPostData('timer-start',{id:future},200,staff);await db.prepare("UPDATE task_time_entries SET starts_at=(now()-interval '13 hours')::text WHERE task_id=? AND ends_at IS NULL",[future]).run();const expiry=await maintain();assert.equal(expiry.stopped,1);assert.equal((await dashboard(staff)).running,null);assert.equal((await taskInfo(future,staff)).actualSeconds,43200);
console.log('PASS daily dashboard categories, scoped overdue notifications, automatic scheduler deduplication and twelve-hour timer expiry');

// Real time cannot be inflated beyond a day through mixed manual and timer entries.
const capped=(await taskPostData('assign',{...assignment,title:'Daily time cap',project:''},201)).id;
const capDate=day(-1);
await taskPostData('time-add',{id:capped,minutes:720,workedOn:capDate,note:'First twelve hours.'},200,staff);
await taskPostData('time-add',{id:capped,minutes:720,workedOn:capDate,note:'Second twelve hours.'},200,staff);
await taskPostData('time-add',{id:capped,minutes:1,workedOn:capDate,note:'Cannot exceed a day.'},400,staff);
await taskPostData('timer-start',{id:capped},200,staff);
await db.prepare("UPDATE task_time_entries SET worked_on=?,starts_at=(now()-interval '13 hours')::text WHERE task_id=? AND ends_at IS NULL",[capDate,capped]).run();
await maintain();assert.equal((await taskInfo(capped,staff)).actualSeconds,86400);
console.log('PASS mixed manual/timer entries respect the twenty-four-hour daily cap');


// Production sees neither Preview tasks nor their notifications, even with a permissive baseline.
await db.prepare('GRANT SELECT ON tasks,notifications TO walshken_production_app',[]).run();await db.prepare("CREATE POLICY task_test_production_select ON tasks FOR SELECT TO walshken_production_app USING(true)",[]).run();await db.prepare("CREATE POLICY task_test_production_notifications ON notifications FOR SELECT TO walshken_production_app USING(true)",[]).run();
await db.prepare('SET ROLE walshken_production_app',[]).run();assert.equal((await db.prepare('SELECT count(*)::int AS count FROM tasks',[]).first()).count,0);assert.equal((await db.prepare("SELECT count(*)::int AS count FROM notifications WHERE release_stage='preview'",[]).first()).count,0);await db.prepare('RESET ROLE',[]).run();
// Suspended accounts and MFA-incomplete sessions cannot use task APIs.
await db.prepare("UPDATE employees SET status='Suspended' WHERE id=?",[staffId]).run();await taskRequest('list',401,staff);await db.prepare("UPDATE employees SET status='Active' WHERE id=?",[staffId]).run();
process.env.WALSHKEN_TASKS_ENABLED='0';await taskRequest('list',404,admin);
console.log('PASS production RLS isolation, account suspension and feature gating');
console.log('PART E TASK TESTS PASSED');
