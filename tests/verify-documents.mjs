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
copyFileSync(join(process.cwd(),"supabase/migrations/20261123220736_messaging_document_references.sql"),join(sandbox,"drizzle/0011_message_documents.sql"));
writeFileSync(join(sandbox,"drizzle/00000_test_roles.sql"),"CREATE ROLE anon; CREATE ROLE authenticated;");
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
await documentRequest('list',401,null);
await documentRequest('upload',403,staff,file('work.png',png));
const uploaded=await post('upload',file('work.png',png),201);
const documentId=uploaded.id;
// Existing document versions remain accessible after same-bucket credential rotation.
await request('integrations/save',409,admin,{provider:'document-storage-review',...settings,bucket:'different-private-documents',enabled:'1'});
const {S3Client:RotationClient,HeadBucketCommand,HeadObjectCommand,PutObjectCommand:RotationPut,DeleteObjectCommand:RotationDelete}=await import('@aws-sdk/client-s3');
const beforeRotationSend=RotationClient.prototype.send,beforeRotationFetch=globalThis.fetch;
try{
 let checks=0;
 RotationClient.prototype.send=async function(command){assert.equal(command.input.Bucket,settings.bucket);assert.ok(command instanceof HeadBucketCommand||command instanceof HeadObjectCommand||command instanceof RotationPut||command instanceof RotationDelete);checks++;return {};};
 globalThis.fetch=async input=>{const url=new URL(input instanceof Request?input.url:String(input));assert.ok(url.hostname.endsWith('supabase.co'));assert.ok(url.pathname.includes('/walshken/verification/'));return new Response(null,{status:403});};
 await request('integrations/save',200,admin,{provider:'document-storage-review',...settings,accessKey:'rotated-document-access',secretKey:secret(),enabled:'1'});
 assert.equal(checks,4);
 RotationClient.prototype.send=async function(){throw new Error('Synthetic replacement credential denied');};
 await request('integrations/save',400,admin,{provider:'document-storage-review',...settings,accessKey:'unusable-document-access',enabled:'1'});
}finally{RotationClient.prototype.send=beforeRotationSend;globalThis.fetch=beforeRotationFetch;}
const {integrationSettings}=await import('../lib/walshken/integration-settings.ts');
assert.equal((await integrationSettings(db,'document-storage-review')).accessKey,'rotated-document-access');
// The shared S3 account also protects document access when no recording exists yet.
const savedDocumentSettings=await integrationSettings(db,'document-storage-review');
const sharedStorage={...settings,bucket:'private-call-recordings'};
await db.prepare("INSERT INTO integrations(id,configuration,enabled,updated_at) VALUES('recording-storage',?,1,?)",[await encryptSettings('recording-storage',sharedStorage),new Date().toISOString()]).run();
await db.prepare("DELETE FROM integrations WHERE id='document-storage-review'").run();
process.env.WALSHKEN_DOCUMENT_BUCKET=settings.bucket;
await request('integrations/save',409,admin,{provider:'recording-storage',...sharedStorage,endpoint:'https://s3.us-east-1.amazonaws.com',region:'us-east-1',enabled:'1'});
try{
 const checkedBuckets=[];
 RotationClient.prototype.send=async function(command){if(command instanceof HeadBucketCommand)checkedBuckets.push(command.input.Bucket);return {};};
 globalThis.fetch=async()=>new Response(null,{status:403});
 await request('integrations/save',200,admin,{provider:'recording-storage',...sharedStorage,accessKey:'rotated-shared-access',secretKey:secret(),enabled:'1'});
 assert.deepEqual(checkedBuckets,[settings.bucket,sharedStorage.bucket]);
 // Moving from shared to dedicated credentials keeps the exact same private document location.
 await request('integrations/save',200,admin,{provider:'document-storage-review',...savedDocumentSettings,enabled:'1'});
}finally{RotationClient.prototype.send=beforeRotationSend;globalThis.fetch=beforeRotationFetch;delete process.env.WALSHKEN_DOCUMENT_BUCKET;}
console.log('PASS private storage credential rotation, rejected relocation, failed-key rollback and shared-account document continuity');
assert.equal((await list(staff)).rows.length,0);
await post('detail',{id:documentId},403,staff);
await rule('organization','walshken','employee',staffId,['view']);
let access=await post('access',{id:documentId,purpose:'view'},200,staff);
let pageImage=await documentRequest('content',200,staff,undefined,'?token='+encodeURIComponent(access.token)+'&page=1');
assert.equal(pageImage.headers.get('content-type'),'image/jpeg');assert.notDeepEqual(pageImage.data,png);
await post('access',{id:documentId,purpose:'download'},403,staff);await post('access',{id:documentId,purpose:'print'},403,staff);
await documentRequest('content',403,admin,undefined,'?token='+encodeURIComponent(access.token));
await documentRequest('content',401,staff,undefined,'?token='+encodeURIComponent(access.token+'tamper'));
await request('files/'+documentId,404,staff);
await request('documents/upload',404,staff,file('bypass.png',png));
await rule('organization','walshken','employee',staffId,['download'],'deny');
await rule('document',documentId,'employee',staffId,['download','print','edit','forward','manage','external']);
await post('access',{id:documentId,purpose:'download'},403,staff);
const deniedRule=(await list()).rules.find(r=>r.effect==='deny'&&r.principal_id===staffId);
await post('rule-remove',{rule:deniedRule.id},403,staff);
await post('rule-remove',{rule:deniedRule.id});
access=await post('access',{id:documentId,purpose:'download'},200,staff);
const original=await documentRequest('content',200,staff,undefined,'?token='+encodeURIComponent(access.token));assert.deepEqual(original.data,png);assert.match(original.headers.get('content-disposition'),/^attachment/);assert.match(original.headers.get('cache-control'),/no-store/);
const printAccess=await post('access',{id:documentId,purpose:'print'},200,staff);
const printed=await documentRequest('content',200,staff,undefined,'?token='+encodeURIComponent(printAccess.token));assert.match(printed.data,/Print document/);assert.doesNotMatch(printed.data,/storage\.supabase/);
await documentRequest('content',200,staff,undefined,'?token='+encodeURIComponent(printAccess.token)+'&page=1');
let detail=await post('detail',{id:documentId});
await post('metadata',{id:documentId,name:'Protected instruction',description:'Current team procedure',category:'Work instruction',expectedVersion:detail.row.current_version,watermark:'1'});
const watermarked=await post('access',{id:documentId,purpose:'view'},200,staff);
const markedImage=await documentRequest('content',200,staff,undefined,'?token='+encodeURIComponent(watermarked.token));assert.notDeepEqual(markedImage.data,pageImage.data);
await post('metadata',{id:documentId,name:'Bad update',description:'',category:'Work instruction',expectedVersion:'stale'},409,staff);
const newer=await post('upload',file('updated.png',png,{id:documentId,expectedVersion:detail.row.current_version,note:'Reviewed procedure'}),201,staff);
assert.equal(newer.id,documentId);
await post('upload',file('stale.png',png,{id:documentId,expectedVersion:detail.row.current_version}),409,staff);
detail=await post('detail',{id:documentId});assert.equal(detail.versions.length,2);assert.equal(detail.versions[0].note,'Reviewed procedure');
const oldVersion=await post('access',{id:documentId,version:detail.versions[1].id,purpose:'view'},200,staff);await documentRequest('content',200,staff,undefined,'?token='+encodeURIComponent(oldVersion.token));
await post('forward',{id:documentId,recipient:guestId},403,staff);
await post('external',{id:documentId,recipient:guestId},200,staff);
let guestAccess=await post('access',{id:documentId,purpose:'view'},200,guest);await documentRequest('content',200,guest,undefined,'?token='+encodeURIComponent(guestAccess.token));
await post('access',{id:documentId,purpose:'download'},403,guest);await post('upload',file('guest.png',png),403,guest);
await post('forward',{id:documentId,recipient:adminId},403,guest);
await rule('document',documentId,'employee',staffId,['external'],'deny');
await documentRequest('content',403,guest,undefined,'?token='+encodeURIComponent(guestAccess.token));
console.log('PASS session-bound previews, original/print controls, deny precedence, watermark, version conflict and external reauthorization');

// Folder inheritance and department policies; no blanket staff visibility is assumed.
const parent=(await post('folder-add',{name:'Operations',department} ,201)).id;
const child=(await post('folder-add',{name:'Instructions',parent},201)).id;
const folderFile=(await post('upload',file('folder.png',png,{folder:child}),201)).id;
// Remove the organization-wide view rule to exercise each scope independently.
for(const r of(await list()).rules.filter(r=>r.scope_type==='organization'&&r.principal_id===staffId))await post('rule-remove',{rule:r.id});
await post('detail',{id:folderFile},403,staff);
await rule('department',department,'all','',['view','upload']);
assert.ok((await list(staff)).rows.some(r=>r.id===folderFile));
const staffFile=(await post('upload',file('employee.png',png,{folder:child}),201,staff)).id;
await post('access',{id:staffFile,purpose:'download'},403,staff);
await rule('folder',parent,'employee',staffId,['download']);
const beforeRevoke=await post('access',{id:folderFile,purpose:'view'},200,staff);
await post('folder-update',{id:parent,revoke:true});
await documentRequest('content',404,staff,undefined,'?token='+encodeURIComponent(beforeRevoke.token));assert.ok(!(await list(staff)).rows.some(r=>r.id===folderFile));
await post('folder-update',{id:parent,restore:true});
assert.ok((await list(staff)).rows.some(r=>r.id===folderFile));
await rule('folder',child,'employee',staffId,['view'],'deny');
await post('detail',{id:folderFile},403,staff);
for(const r of(await list()).rules.filter(r=>r.scope_type==='folder'&&r.scope_id===child&&r.effect==='deny'))await post('rule-remove',{rule:r.id});
// Group permissions disappear when membership is removed.
const group=(await request('messages/create',201,admin,{kind:'Group',title:'Document project',members:[staffId]})).id;
const groupFolder=(await post('folder-add',{name:'Project documents',group},201)).id;
const groupFile=(await post('upload',file('project.png',png,{folder:groupFolder}),201)).id;
await rule('group',group,'all','',['view']);assert.ok((await list(staff)).rows.some(r=>r.id===groupFile));
await request('messages/remove-group',200,admin,{conversation:group});
assert.ok(!(await list(staff)).rows.some(r=>r.id===groupFile));
await request('messages/restore-group',200,admin,{conversation:group});
assert.ok((await list(staff)).rows.some(r=>r.id===groupFile));
await db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND employee_id=?',[group,staffId]).run();await post('detail',{id:groupFile},403,staff);
console.log('PASS organization, department, group, ancestor-folder and document scopes, including membership and folder revocation');

// Forwarding grants no original download rights and follows the sender's current rights.
const colleague={...employee,name:'Document recipient',email:`recipient-${runId}@walshken.test`,employeeNo:'REC-'+runId};
const added=await request('employees/add',201,admin,colleague);await request('session/activate',200,coworker,{email:colleague.email,password:coworker.password,code:added.code});coworker.email=colleague.email;await request('session/login',200,coworker,coworker);await enroll(coworker);
const coworkerId=(await request('view/employees',200,admin)).rows.find(r=>r.email===colleague.email).id;
await rule('document',documentId,'employee',staffId,['view']);
await post('forward',{id:documentId,recipient:coworkerId},200,staff);
let forwarded=await post('access',{id:documentId,purpose:'view'},200,coworker);await post('access',{id:documentId,purpose:'download'},403,coworker);
assert.ok((await request('view/notifications',200,coworker)).rows.some(r=>r.title==='Document shared'));
await rule('document',documentId,'employee',staffId,['forward'],'deny');await documentRequest('content',403,coworker,undefined,'?token='+encodeURIComponent(forwarded.token));
await rule('document',documentId,'employee',coworkerId,['view'],'deny');await post('forward',{id:documentId,recipient:coworkerId},403);
console.log('PASS internal forwarding, recipient notifications, explicit recipient denial and sender revocation');

// Chat shares document references without granting the recipient access.
const chatDocument=(await post('upload',file('secure-chat.png',png),201)).id;
const dm=(await request('messages/create',201,admin,{kind:'Direct',members:[staffId]})).id;
const privateGroup=(await request('messages/create',201,admin,{kind:'Group',title:'Private document discussion',members:[staffId,coworkerId]})).id;
const attachments=(thread)=>`messages/attachments?conversation=${thread}&q=secure-chat`;
await request(attachments(dm),404,admin);
process.env.WALSHKEN_MESSAGE_DOCUMENTS_ENABLED='1';
await request(attachments(dm),401);
await request(attachments(dm),404,coworker);
await request('messages/send',403,admin,{conversation:dm,document:chatDocument});
await rule('document',chatDocument,'employee',staffId,['view','forward']);
assert.deepEqual((await request(attachments(dm),200,staff)).documents,[{id:chatDocument,name:'secure-chat.png'}]);
const sent=await request('messages/send',201,admin,{conversation:dm,document:chatDocument});
const attached=(await request('conversation/'+dm,200,staff)).rows.find(row=>row.id===sent.id);
assert.equal(attached.attachment_id,chatDocument);
assert.equal(attached.attachment_name,'secure-chat.png');
assert.equal(attached.body,'');
await request('messages/send',403,admin,{conversation:privateGroup,document:chatDocument});
await rule('document',chatDocument,'employee',coworkerId,['view']);
await request('communication-policy/save',200,admin,{creation:'All staff',approval:'0',members:'Owners',forwarding:'All staff',external:'1',messageChanges:'Sender',retentionDays:30});
const external=(await request('messages/create',201,admin,{kind:'External',title:'External project',members:[staffId,guestId]})).id;
await request(attachments(external),403,staff);
await request('messages/send',403,admin,{conversation:external,document:chatDocument});
await request('messages/forward',403,admin,{conversation:dm,destination:external,id:sent.id});
await request('messages/forward',201,staff,{conversation:dm,destination:privateGroup,id:sent.id});
assert.equal((await request('conversation/'+privateGroup,200,coworker)).rows[0].attachment_id,chatDocument);
const chatPreview=await post('access',{id:chatDocument,purpose:'view'},200,coworker);
const chatToken='?token='+encodeURIComponent(chatPreview.token)+'&page=1';
await documentRequest('content',200,coworker,undefined,chatToken);
await documentRequest('content',403,staff,undefined,chatToken);
await post('access',{id:chatDocument,purpose:'download'},403,coworker);
await rule('document',chatDocument,'employee',coworkerId,['view'],'deny');
const revokedAttachment=(await request('conversation/'+privateGroup,200,coworker)).rows[0];
assert.equal(revokedAttachment.attachment_unavailable,1);
assert.equal(revokedAttachment.attachment_id,null);
assert.equal(revokedAttachment.attachment_name,null);
await documentRequest('content',403,coworker,undefined,chatToken);
await request('messages/forward',403,staff,{conversation:dm,destination:privateGroup,id:sent.id});
const chatEvents=await db.prepare("SELECT id FROM doc_events WHERE document_id=? AND action='Shared in conversation'",[chatDocument]).all();
assert.equal(chatEvents.results.length,2);
console.log('PASS private and group chat attachments, authorized forwarding, guest and public denial, current ACLs, token binding and audit history');

// Put the independent format checks in a fresh rate-limit window.
offset+=60_001;
// Build real supported file fixtures and rasterize all of them.
function makePdf(){const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];const content='BT /F1 18 Tf 40 740 Td (Private work instruction) Tj ET';objects.push('<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream');let body='%PDF-1.4\n',offsets=[0];for(const[i,obj]of objects.entries()){offsets.push(Buffer.byteLength(body));body+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';}const offset=Buffer.byteLength(body);body+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(v=>String(v).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+offset+'\n%%EOF';return Buffer.from(body);}
const zip=new JSZip();zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Private Word work instruction</w:t></w:r></w:p></w:body></w:document>');const docx=await zip.generateAsync({type:'nodebuffer'});
const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Payroll inputs');sheet.addRow(['Employee','Hours']);sheet.addRow(['Restricted person',38]);sheet.getCell('C2').value={formula:'B2*2',result:76};const xlsx=Buffer.from(await workbook.xlsx.writeBuffer());
const formats=[['instruction.pdf',makePdf()],['instruction.docx',docx],['sheet.xlsx',xlsx],['image.jpg',canvas.toBuffer('image/jpeg',80)],['image.webp',canvas.toBuffer('image/webp',80)]];
for(const[name,bytes]of formats){const item=(await post('upload',file(name,bytes),201)).id,view=await post('access',{id:item,purpose:'view'}),render=await documentRequest('content',200,admin,undefined,'?token='+encodeURIComponent(view.token));assert.equal(render.headers.get('content-type'),'image/jpeg');assert.ok(render.data.length>100);console.log('PASS real '+name+' safe preview');}
await post('upload',file('invalid.pdf',Buffer.from('not a PDF')),400);
await post('upload',file('active.svg',Buffer.from('<svg onload="alert(1)"/>')),400);
await post('upload',file('too-large.pdf',Buffer.alloc(3*1024*1024+1)),400);
const malicious=new JSZip();malicious.file('word/document.xml','<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><w:document>&y;</w:document>');await post('upload',file('unsafe.docx',await malicious.generateAsync({type:'nodebuffer'})),400);
await post('access',{id:documentId,version:'wrong-org-version',purpose:'view'},404);
await post('rule-add',{scope:'department',target:'outside-org',principalType:'all',permissions:['view'],effect:'allow'},404);
await db.prepare("UPDATE sessions SET expires_at=? WHERE employee_id=? AND ended_at IS NULL",[new Date(Date.now()-1000).toISOString(),staffId]).run();await documentRequest('content',401,staff,undefined,'?token='+encodeURIComponent(watermarked.token));
console.log('PASS invalid, oversized, active and cross-organization content rejected; expired sessions denied');
const revocation=await post('access',{id:documentId,purpose:'view'});await post('revoke',{id:documentId});await documentRequest('content',404,admin,undefined,'?token='+encodeURIComponent(revocation.token));await post('restore',{id:documentId});
await post('delete',{id:documentId});await post('access',{id:documentId,purpose:'download'},404);await post('restore',{id:documentId},404);
const events=(await post('audit',{})).rows;for(const action of['Uploaded','Opened','Preview page opened','Printed','Downloaded','Modified','Deleted','Forwarded internally','Shared externally','Access revoked','Permission revoked','Version uploaded'])assert.ok(events.some(e=>e.action===action),'Missing audit '+action);
await db.prepare("UPDATE doc_object_cleanup SET created_at=?",[new Date(Date.now()-600000).toISOString()]).run();const cleaned=await post('cleanup',{});assert.equal(cleaned.failed,0);assert.ok(![...objects.keys()].some(key=>key.includes('/'+documentId+'/')),'Deleted originals still exist');
assert.equal((await db.prepare('SELECT count(*)::int AS count FROM doc_object_cleanup',[]).first()).count,0);
console.log('PASS document revocation/deletion, immutable history, complete action audit and durable private-object cleanup');
process.env.WALSHKEN_DOCUMENTS_ENABLED='0';await documentRequest('list',404,admin);
console.log('PART D DOCUMENT TESTS PASSED');
