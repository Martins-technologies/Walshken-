import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/workspace/[...parts]/route.ts";
import { createHmac, createHash, randomBytes } from "node:crypto";

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
    return {...confirmed,mfaCode,setupKey:setup.setupKey};
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

const {AccessToken,TokenVerifier}=await import('livekit-server-sdk');
const {POST:webhook}=await import('../app/api/livekit/webhook/route.ts');
const {GET:maintenance}=await import('../app/api/livekit/maintenance/route.ts');
const {encryptSettings}=await import('../lib/walshken/server.ts');
const rooms=new Map(),participants=new Map(),egresses=new Map();
const settings={url:'wss://walshken-qa.livekit.cloud',apiKey:'qa-livekit-key',apiSecret:secret()+secret()};
let providerCalls=0;
const {integrationSettings,integrationStatuses}=await import('../lib/walshken/integration-settings.ts');
process.env.WALSHKEN_SERVER_INTEGRATIONS=JSON.stringify({livekit:settings});
assert.deepEqual(await integrationSettings(db,'livekit'),settings);
assert.equal((await request('view/calls',200,staff)).provider,true);
let statusRows=(await request('view/integrations',200,admin)).rows;
assert.equal(statusRows.find(row=>row.id==='livekit').source,'server');
assert.ok(!JSON.stringify(statusRows).includes(settings.apiSecret));
await request('integrations/disable',200,admin,{provider:'livekit'});
assert.equal(await integrationSettings(db,'livekit'),null,'A saved disable must override protected deployment defaults');
assert.deepEqual(await integrationSettings(db,'livekit',false),settings,'Retained recording reads can use disabled saved settings');
assert.equal((await request('view/calls',200,staff)).provider,false);
await db.prepare("DELETE FROM integrations WHERE id='livekit'",[]).run();
process.env.WALSHKEN_SERVER_INTEGRATIONS='{invalid';
await assert.rejects(()=>integrationStatuses(db,adminId));
delete process.env.WALSHKEN_SERVER_INTEGRATIONS;
console.log('PASS protected deployment provider defaults, no UI secret disclosure and persisted administrator disable precedence');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,opts)=>{
  assert.equal(new URL(url).origin,'https://walshken-qa.livekit.cloud');
  providerCalls++;
  const method=new URL(url).pathname.split('/').at(-1),body=JSON.parse(opts.body);
  const claims=await new TokenVerifier(settings.apiKey,settings.apiSecret).verify(opts.headers.Authorization.replace(/^Bearer /,''));
  if(method==='ListRooms'){assert.ok(claims.video.roomList);return Response.json({rooms:[...rooms.values()]});}
  if(method==='CreateRoom'){assert.ok(claims.video.roomCreate);rooms.set(body.name,{name:body.name,sid:'RM_'+body.name});return Response.json(rooms.get(body.name));}
  if(method==='ListParticipants')return Response.json({participants:participants.get(body.room)??[]});
  if(method==='DeleteRoom'){rooms.delete(body.room);participants.delete(body.room);return Response.json({});}
  if(method==='RemoveParticipant'){participants.set(body.room,(participants.get(body.room)??[]).filter(p=>p.identity!==body.identity));return Response.json({});}
  if(method==='UpdateParticipant'){const person=(participants.get(body.room)??[]).find(p=>p.identity===body.identity);if(!person)return Response.json({code:'not_found',msg:'Not connected'},{status:404});Object.assign(person,{permission:body.permission});return Response.json(person);}
  if(method==='GetParticipant'){const person=(participants.get(body.room)??[]).find(p=>p.identity===body.identity);return person?Response.json(person):Response.json({code:'not_found',msg:'Missing'},{status:404});}
  if(method==='MutePublishedTrack')return Response.json({track:{sid:body.trackSid,muted:true}});
  if(method==='StartEgress'){
    assert.ok(claims.video.roomRecord);assert.equal(body.storage.s3.bucket,'private-call-recordings');assert.equal(body.outputs[0].file.disableManifest,true);
    const egress={egressId:'EG_'+secret(),roomName:body.roomName,status:'EGRESS_ACTIVE',startedAt:String(BigInt(Date.now())*1000000n),egress:body};egresses.set(egress.egressId,egress);return Response.json(egress);
  }
  if(method==='ListEgress')return Response.json({items:[...egresses.values()].filter(e=>!body.roomName||body.roomName===e.roomName)});
  if(method==='StopEgress'){const egress=egresses.get(body.egressId);egress.status='EGRESS_COMPLETE';egress.endedAt=String(BigInt(Date.now())*1000000n);return Response.json(egress);}
  throw new Error('Unexpected LiveKit request '+method);
};
const begins=new Date(Date.now()+60000).toISOString(),ends=new Date(Date.now()+3600000).toISOString();
const values={title:'Audio access verification',type:'One-to-one',mode:'Audio',waiting:'1',screenSharing:'Host',members:[staffId],startsAt:begins,endsAt:ends};
await request('integrations/save',403,staff,{provider:'livekit',...settings,enabled:'1'});
await request('integrations/save',400,admin,{provider:'livekit',...settings,url:'wss://127.0.0.1',enabled:'1'});
await request('integrations/save',400,admin,{provider:'livekit',...settings,url:'https://walshken-qa.livekit.cloud',enabled:'1'});
await request('integrations/save',200,admin,{provider:'livekit',...settings,enabled:'1'});
assert.equal((await request('view/calls',200,staff)).provider,true);
const meeting=(await request('calls/schedule',201,admin,values)).id;
assert.ok((await request('view/notifications',200,staff)).rows.find(r=>r.href.endsWith(meeting)));
await request('calls/join',404,guest,{id:meeting});
await request('calls/admit',403,staff,{id:meeting,employee:staffId});
assert.ok((await request('calls/join',202,staff,{id:meeting})).waiting);
assert.ok((await request('meeting/'+meeting,200,admin)).members.find(p=>p.id===staffId).requested_at);
await request('calls/withdraw-request',200,staff,{id:meeting});
assert.equal((await request('meeting/'+meeting,200,admin)).members.find(p=>p.id===staffId).requested_at,null);
await request('calls/join',202,staff,{id:meeting});
await request('calls/admit',200,admin,{id:meeting,employee:staffId});
const staffAccess=await request('calls/join',200,staff,{id:meeting});
const staffClaims=await new TokenVerifier(settings.apiKey,settings.apiSecret).verify(staffAccess.token);
assert.deepEqual(staffClaims.video.canPublishSources,['microphone']);
assert.equal(staffClaims.video.canPublishData,false);
assert.ok(!staffClaims.video.roomAdmin&&!staffClaims.video.roomRecord);
assert.ok(staffClaims.exp-staffClaims.nbf<=60);
const hostAccess=await request('calls/join',200,admin,{id:meeting});
const hostClaims=await new TokenVerifier(settings.apiKey,settings.apiSecret).verify(hostAccess.token);
assert.deepEqual(hostClaims.video.canPublishSources,['microphone','screen_share','screen_share_audio']);
assert.ok(!hostClaims.video.roomAdmin&&!hostClaims.video.roomRecord);
assert.equal((await request('meeting/'+meeting,200,admin)).meeting.started_at,null,'Issuing a token must not invent call start time');
let serial=0;
async function emit(event,room,participant,extra={},expected=200,eventId){
  const payload={event,room:{name:room,sid:'RM_'+room},participant,...extra,id:eventId??'event-'+(++serial),createdAt:String(Math.floor(Date.now()/1000))};
  const raw=JSON.stringify(payload),token=new AccessToken(settings.apiKey,settings.apiSecret,{ttl:300});token.sha256=createHash('sha256').update(raw).digest('base64');
  const response=await webhook(new Request(origin+'/api/livekit/webhook',{method:'POST',headers:{authorization:await token.toJwt(),'content-type':'application/webhook+json'},body:raw}));
  const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
}
const room='wk-'+meeting;
const hostParticipant={identity:adminId,name:'QA host',sid:'PA_host',joinedAt:String(Math.floor(Date.now()/1000)),kind:'STANDARD'};
const staffParticipant={identity:staffId,name:'QA staff',sid:'PA_staff',joinedAt:String(Math.floor(Date.now()/1000)),kind:'STANDARD'};
participants.set(room,[hostParticipant,staffParticipant]);
await emit('participant_joined',room,hostParticipant,{},200,'stable-event');
await emit('participant_joined',room,hostParticipant,{},200,'stable-event');
await emit('participant_joined',room,staffParticipant);
let detail=await request('meeting/'+meeting,200,admin);
assert.ok(detail.meeting.started_at);assert.equal(detail.attendance.find(r=>r.id===adminId).connections,1);
assert.equal(detail.attendance.find(r=>r.id===staffId).connections,1);
assert.equal((await webhook(new Request(origin+'/api/livekit/webhook',{method:'POST',body:'{}'}))).status,401);
const modifiedPayload=JSON.stringify({event:'room_finished',room:{name:room},id:'tamper'}),signer=new AccessToken(settings.apiKey,settings.apiSecret,{ttl:60});signer.sha256=createHash('sha256').update('{}').digest('base64');
assert.equal((await webhook(new Request(origin+'/api/livekit/webhook',{method:'POST',body:modifiedPayload,headers:{authorization:await signer.toJwt()}}))).status,401);
await request('meeting-attendance/'+meeting,403,staff);
const report=await request('meeting-attendance/'+meeting,200,admin);assert.ok(report.toString().includes('Duration seconds'));
await request('calls/permissions',403,staff,{id:meeting,employee:adminId,publish:'0',share:'0'});
await request('calls/permissions',200,admin,{id:meeting,employee:staffId,publish:'0',share:'0',coHost:'0'});
const listen=await request('calls/join',200,staff,{id:meeting});assert.equal((await new TokenVerifier(settings.apiKey,settings.apiSecret).verify(listen.token)).video.canPublish,false);
await request('calls/lock',200,admin,{id:meeting,locked:'1'});await request('calls/join',409,staff,{id:meeting});
await request('calls/lock',200,admin,{id:meeting,locked:'0'});
await request('calls/permissions',200,admin,{id:meeting,employee:staffId,publish:'1',share:'1',coHost:'1'});
assert.ok((await request('meeting/'+meeting,200,staff)).host);
await request('calls/permissions',403,staff,{id:meeting,employee:adminId,publish:'0',share:'0',coHost:'0'});
await request('calls/permissions',200,admin,{id:meeting,employee:staffId,publish:'1',share:'1',coHost:'0'});
await request('integrations/disable',409,admin,{provider:'livekit'});
await request('calls/record-start',403,staff,{id:meeting});
await request('calls/record-start',403,admin,{id:meeting});
await request('calls/policy',403,staff,{recordingPolicy:'Admins',retention:'30',enabled:'0'});
await request('calls/policy',200,admin,{recordingPolicy:'Admins',retention:'7',enabled:'1'});
await request('calls/schedule',400,admin,{...values,members:[staffId,guestId]});
await request('calls/invite',403,staff,{id:meeting,employee:guestId});
await request('calls/invite',200,admin,{id:meeting,employee:guestId});
await request('calls/join',202,guest,{id:meeting});
await request('calls/admit',200,admin,{id:meeting,employee:guestId});
await request('calls/join',200,guest,{id:meeting});
await request('calls/remove',200,admin,{id:meeting,employee:guestId});
await request('calls/join',404,guest,{id:meeting});
await request('calls/invite',200,admin,{id:meeting,employee:guestId});
await request('calls/policy',200,admin,{recordingPolicy:'Admins',retention:'7',enabled:'0'});
await request('calls/join',404,guest,{id:meeting});
console.log('PASS private audio/video tokens, waiting admission, co-host and media permissions, external invitations, revocation, signed webhook validation and actual attendance');

// Storage transport is independently verified when credentials are enabled. These tests exercise actual SQL, signatures and SDK serialization with provider responses simulated.
const storage={endpoint:'https://ssggjxyexwkshtcypsaq.storage.supabase.co/storage/v1/s3',region:'us-west-2',bucket:'private-call-recordings',accessKey:'qa-access',secretKey:secret()};
await db.prepare("INSERT INTO integrations (id,configuration,enabled) VALUES ('recording-storage',?,1)",[await encryptSettings('recording-storage',storage)]).run();
await db.prepare('UPDATE meetings SET recording_enabled=1,recording_retention_days=7 WHERE id=?',[meeting]).run();
await request('calls/record-start',409,admin,{id:meeting});
await request('calls/consent',200,admin,{id:meeting,consent:'1'});
await request('calls/record-start',409,admin,{id:meeting});
await request('calls/consent',200,staff,{id:meeting,consent:'1'});
await request('calls/record-start',200,admin,{id:meeting});
let recording=(await request('meeting/'+meeting,200,admin)).recordings[0];assert.equal(recording.status,'Active');
await request('calls/record-start',409,admin,{id:meeting});
await request('calls/download-recording',403,staff,{id:meeting,recording:recording.id});
await request('calls/invite',409,admin,{id:meeting,employee:guestId});
await request('integrations/save',409,admin,{provider:'recording-storage',...storage,enabled:'1'});
await request('calls/consent',200,staff,{id:meeting,consent:'0'});
recording=(await request('meeting/'+meeting,200,admin)).recordings[0];assert.equal(recording.status,'Complete');
// Retained objects permit a verified key rotation but never a silent location change.
await request('integrations/save',409,admin,{provider:'recording-storage',...storage,bucket:'different-private-bucket',enabled:'1'});
const {S3Client:RotationClient,HeadBucketCommand,HeadObjectCommand,PutObjectCommand:RotationPut,DeleteObjectCommand:RotationDelete}=await import('@aws-sdk/client-s3');
const beforeRotationSend=RotationClient.prototype.send,beforeRotationFetch=globalThis.fetch;
const rotatedStorage={...storage,accessKey:'qa-rotated-access',secretKey:secret()};let storageChecks=0;
try{
 RotationClient.prototype.send=async function(command){assert.equal(command.input.Bucket,storage.bucket);assert.ok(command instanceof HeadBucketCommand||command instanceof HeadObjectCommand||command instanceof RotationPut||command instanceof RotationDelete);storageChecks++;return {};};
 globalThis.fetch=async input=>{const url=new URL(input instanceof Request?input.url:String(input));assert.ok(url.hostname.endsWith('supabase.co'));assert.ok(url.pathname.includes('/walshken/verification/'));return new Response(null,{status:403});};
 await request('integrations/save',200,admin,{provider:'recording-storage',...rotatedStorage,enabled:'1'});
 assert.equal(storageChecks,4);
}finally{RotationClient.prototype.send=beforeRotationSend;globalThis.fetch=beforeRotationFetch;}
assert.equal((await integrationSettings(db,'recording-storage')).accessKey,rotatedStorage.accessKey);
const download=await request('calls/download-recording',200,admin,{id:meeting,recording:recording.id});assert.equal(new URL(download.url).searchParams.get('X-Amz-Expires'),'60');
assert.match(new URL(download.url).searchParams.get('X-Amz-Credential'),/^qa-rotated-access\//);
await db.prepare('UPDATE meeting_recordings SET expires_at=? WHERE id=?',[new Date(Date.now()-1000).toISOString(),recording.id]).run();
await request('calls/download-recording',410,admin,{id:meeting,recording:recording.id});
await request('calls/record-start',409,admin,{id:meeting});
await request('calls/cancel',409,admin,{id:meeting});
await request('calls/end',403,staff,{id:meeting});
await request('calls/end',200,admin,{id:meeting});
await request('calls/join',409,staff,{id:meeting});
assert.equal(rooms.has(room),false);
assert.ok((await request('meeting/'+meeting,200,admin)).meeting.ended_at);
const {id:video}=await request('calls/start',201,admin,{...values,title:'Video call',mode:'Video',waiting:'0',screenSharing:'Everyone',recording:'0'});
const videoAccess=await request('calls/join',200,staff,{id:video}),videoClaims=await new TokenVerifier(settings.apiKey,settings.apiSecret).verify(videoAccess.token);
assert.deepEqual(videoClaims.video.canPublishSources,['microphone','camera','screen_share','screen_share_audio']);
await request('calls/remove',200,admin,{id:video,employee:staffId});await request('calls/join',404,staff,{id:video});
process.env.CRON_SECRET=secret();
assert.equal((await maintenance(new Request(origin+'/api/livekit/maintenance'))).status,401);
await db.prepare('UPDATE meetings SET ends_at=? WHERE id=?',[new Date(Date.now()-1000).toISOString(),video]).run();
// Verify the storage deletion command without contacting a customer's bucket.
const {S3Client,DeleteObjectCommand}=await import('@aws-sdk/client-s3');
const actualSend=S3Client.prototype.send;let deletions=0;
S3Client.prototype.send=async function(command){assert.ok(command instanceof DeleteObjectCommand);assert.equal(command.input.Bucket,storage.bucket);assert.ok(command.input.Key.startsWith('walshken/meetings/'));deletions++;return {};};
const sweep=await maintenance(new Request(origin+'/api/livekit/maintenance',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}));assert.equal(sweep.status,200);assert.equal(deletions,1);assert.equal((await request('meeting/'+meeting,200,admin)).recordings[0].status,'Deleted');S3Client.prototype.send=actualSend;
assert.ok((await request('meeting/'+video,200,admin)).meeting.ended_at);
console.log('PASS opt-in recording, unanimous consent, withdrawal stops recording, private expiring download permissions, retention access expiry, end-for-all and authenticated expiry maintenance');
assert.ok(providerCalls>0);
process.env.WALSHKEN_INTEGRATION_KEY_V2=randomBytes(32).toString('base64');
await request('integrations/migrate-encryption',409,admin,{password:admin.password,code:adminMfa.recoveryCodes[0]});
process.env.WALSHKEN_ALLOW_LEGACY_MIGRATION='1';
await request('integrations/migrate-encryption',403,staff,{password:staff.password,code:'123456'});
await request('integrations/migrate-encryption',401,admin,{password:'incorrect-password',code:adminMfa.recoveryCodes[0]});
await request('integrations/migrate-encryption',200,admin,{password:admin.password,code:adminMfa.recoveryCodes[0]});
assert.equal((await db.prepare("SELECT count(*)::int AS n FROM staff_mfa WHERE secret NOT LIKE 'v2.%'",[]).first()).n,0);
delete process.env.WALSHKEN_INTEGRATION_KEY;
offset+=30000;
await request('session/login',200,admin,{email:admin.email,password:admin.password,mfaCode:authenticatorCode(adminMfa.setupKey,0)});
console.log('PASS authenticated encryption migration preserves passwords and original authenticator codes and works without exposing or copying the legacy key');
process.env.WALSHKEN_RELEASE_SCOPE='staff-collaboration';
assert.equal((await request('view/dashboard',200,admin)).collaborationOverview,true);
await request('view/attendance',403,admin);
await request('attendance/in',404,admin,{});
await request('view/calls',200,admin);
await request('view/projects',200,admin);
console.log('PASS release navigation and API scope preserves collaboration and gates unreleased modules');
globalThis.fetch=originalFetch;globalThis.Date=RealDate;
process.exit(0);
