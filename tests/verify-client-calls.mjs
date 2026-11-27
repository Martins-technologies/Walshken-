import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { GET, POST } from "../app/api/client-calls/[audience]/[action]/route.ts";
import { POST as hook } from "../app/api/livekit/webhook/route.ts";
import { database, digest, now, one, run } from "../lib/walshken/server.ts";

const root=process.cwd(), sandbox=mkdtempSync(join(tmpdir(),"walshken-client-calls-"));
const migrations=join(sandbox,"supabase","migrations");
mkdirSync(migrations,{recursive:true});symlinkSync(join(root,"drizzle"),join(sandbox,"drizzle"),"dir");
for(const migration of ["20261125231710_staff_unit_memberships.sql","20261127090000_client_identity.sql","20261127090200_client_cases.sql","20261127090700_client_calls.sql"]) {
  copyFileSync(join(root,"supabase","migrations",migration),join(migrations,migration));
}
process.chdir(sandbox);process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
process.env.WALSHKEN_CLIENT_PORTAL_ENABLED="1";
process.env.WALSHKEN_REQUIRE_STAFF_MFA="1";
const origin="https://staff-call-test.walshken.test";
const vulnerableFields=/private-(?:staff|admin|support)|@staff\.test|123-555-0110/i;
const later=(seconds)=>new Date(Date.now()+seconds*1000).toISOString();
const db=database();
await run(db,"INSERT INTO organizations(id,name,time_zone) VALUES('walshken','Walshken','UTC')");

async function employee(name,role,mfa=true){
  const id=randomUUID(), token=randomUUID()+randomUUID();
  await run(db,`INSERT INTO employees(id,org_id,employee_no,name,email,role,phone) VALUES(?,'walshken',?,?,?,?,?)`,id,id,name,`${name}@staff.test`,role,"123-555-0110");
  await run(db,"INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,?,'fixture')",await digest(token),id,later(3600));
  if(mfa)await run(db,"INSERT INTO staff_mfa(employee_id,secret,setup_expires_at,confirmed_at) VALUES(?,'fixture',?,?)",id,later(10),now());
  return {id,cookie:`walshken_session=${token}`};
}

async function customer(name,verified=true){
  const id=randomUUID(), token=randomBytes(32).toString("hex"), session=randomUUID();
  await run(db,"INSERT INTO customers(id,name,email,password_hash,email_verified_at) VALUES(?,?,?,'fixture',?)",id,name,`${id}@client.test`,verified?now():null);
  await run(db,"INSERT INTO customer_sessions(id,customer_id,expires_at,session_ref,idle_expires_at,last_seen_at) VALUES(?,?,?,?,?,?)",await digest(token),id,later(3600),session,later(3600),now());
  return {id,cookie:`walshken_customer=${token}`,session};
}

const [admin,representative,office,outsider,unconfirmed,client,peer,unverified]=await Promise.all([
  employee("private-admin","super_admin"),employee("private-staff","employee"),employee("private-support","employee"),
  employee("unrelated","employee"),employee("inactive-authenticator","employee",false),customer("Client One"),customer("Client Two"),customer("Unverified",false),
]);
async function newCase(customer,employee,alias,reference){
  const id=randomUUID();
  await run(db,`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,assigned_employee_id,representative_name,representative_designation,created_at,updated_at)
    VALUES(?,'walshken',?,?,?,'consultation','CA',?,?,?, ?,?)`,id,customer.id,reference,"Case "+reference,employee.id,alias,"Case representative",now(),now());
  return id;
}
const caseId=await newCase(client,representative,"Walshken Case Desk","QA-101");
const peerCase=await newCase(peer,representative,"Walshken Case Desk","QA-102");

async function call(audience,action,expected,account,data,source=origin){
  const request=new Request(`${origin}/api/client-calls/${audience}/${action}`,{
    method:data?"POST":"GET",headers:{origin:source,...account?.cookie?{cookie:account.cookie}:{},...data?{"content-type":"application/json"}:{}},
    body:data?JSON.stringify(data):undefined,
  });
  const response=await (data?POST:GET)(request,{params:Promise.resolve({audience,action:action.split("?")[0]})});
  const body=await response.json();assert.equal(response.status,expected,`${audience}/${action} ${JSON.stringify(body)}`);
  assert.match(response.headers.get("cache-control"),/no-store/);
  if(audience==="client")assert.doesNotMatch(JSON.stringify(body),vulnerableFields);
  return body;
}

const settings={url:"wss://walshken-client-preview-test.livekit.cloud",apiKey:"client-fixture",apiSecret:randomBytes(40).toString("hex")};
const rooms=new Map(), people=new Map(), withdrawals=[], recordings=[];
const verify=new TokenVerifier(settings.apiKey,settings.apiSecret);
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  const endpoint=new URL(url),method=endpoint.pathname.split("/").at(-1);
  assert.equal(endpoint.origin,settings.url.replace(/^wss:/,"https:"));
  const input=JSON.parse(options.body);
  const signer=await verify.verify(options.headers.Authorization.replace(/^Bearer /,""));
  if(method==="CreateRoom"){
    assert.ok(signer.video.roomCreate);assert.equal(input.maxParticipants,2);assert.match(input.name,/^wk-client-/);assert.equal(input.egress,undefined);
    const room={name:input.name,sid:`RM_${input.name}`};rooms.set(input.name,room);return Response.json(room);
  }
  if(method==="ListParticipants")return Response.json({participants:people.get(input.room)??[]});
  if(method==="DeleteRoom"){rooms.delete(input.room);people.delete(input.room);return Response.json({});}
  if(method==="RemoveParticipant"){withdrawals.push(input.identity);return Response.json({});}
  if(method==="StopEgress"){recordings.push(input.egressId);return Response.json({egressId:input.egressId,status:"EGRESS_COMPLETE"});}
  throw Error(`Unexpected provider request ${method}`);
};

async function webhook(event,room,participant,extra={},expected=200,eventId=randomUUID()){
  const raw=JSON.stringify({id:eventId,event,room:{name:room},participant,...extra,createdAt:String(Math.floor(Date.now()/1000))});
  const token=new AccessToken(settings.apiKey,settings.apiSecret,{ttl:60});token.sha256=createHash("sha256").update(raw).digest("base64");
  const response=await hook(new Request(`${origin}/api/livekit/webhook`,{method:"POST",headers:{authorization:await token.toJwt()},body:raw}));
  assert.equal(response.status,expected,JSON.stringify(await response.json()));
}

try{
  await call("client","activity",401,null);
  await call("client","activity",403,unverified);
  await call("staff","activity",403,unconfirmed);
  await call("staff","configuration",403,representative);
  await call("client","configure",403,client,{});
  await call("client","start",403,client,{case:caseId,target:"representative",mode:"Audio"},"https://outside.test");
  assert.equal((await call("client","activity",200,client)).configured,false);
  const offline=await call("client","start",200,client,{case:caseId,target:"representative",mode:"Audio"});assert.equal(offline.call.status,"Unavailable");
  process.env.WALSHKEN_SERVER_INTEGRATIONS=JSON.stringify({livekit:settings});
  await call("staff","configure",400,admin,{kind:"Office",name:"secret@staff.test",employee:office.id,enabled:true});
  await call("staff","configure",200,admin,{kind:"Office",name:"Walshken Office",employee:office.id,enabled:true});
  await call("staff","configure",200,admin,{kind:"Support",name:"Walshken Support",employee:office.id,enabled:true});
  const setup=await call("staff","configuration",200,admin);
  assert.equal(setup.configured,true);
  const endpoint=setup.endpoints.find(row=>row.kind==="Office");
  const directory=await call("client","activity",200,client);
  assert.deepEqual(directory.destinations.map(row=>row.name),["Walshken Case Desk","Walshken Office","Walshken Support"]);
  await call("client","activity?case="+peerCase,404,client);
  await call("client","start",404,client,{case:peerCase,target:"representative",mode:"Audio"});
  await call("client","start",404,client,{target:outsider.id,mode:"Audio"});
  await call("client","start",400,client,{case:caseId,target:endpoint.id,mode:"Audio"});
  await call("staff","start",404,outsider,{case:caseId,mode:"Audio"});

  const ring=(await call("client","start",201,client,{case:caseId,target:"representative",mode:"Audio",recording:true,screenSharing:true})).call;
  const busy=(await call("client","start",200,peer,{case:peerCase,target:"representative",mode:"Audio"})).call;
  assert.equal(busy.status,"Busy");
  assert.equal((await call("staff","activity",200,representative)).calls[0].direction,"incoming");
  assert.ok(await one(db,"SELECT id FROM notifications WHERE employee_id=? AND title='Incoming client call'",representative.id));
  await call("client","token",409,client,{id:ring.id});
  await call("staff","accept",404,outsider,{id:ring.id});
  await call("client","accept",403,client,{id:ring.id});
  await call("client","token",404,peer,{id:ring.id});
  await call("staff","accept",200,representative,{id:ring.id});
  const audio=(await call("client","token",200,client,{id:ring.id})).token;
  const audioGrant=await verify.verify(audio);
  assert.deepEqual(audioGrant.video.canPublishSources,["microphone"]);
  assert.ok(!audioGrant.video.roomAdmin&&!audioGrant.video.roomRecord&&!audioGrant.video.canPublishData);
  assert.ok(audioGrant.exp-audioGrant.nbf<=60);
  await call("client","record",400,client,{id:ring.id});
  const staffAudio=await verify.verify((await call("staff","token",200,representative,{id:ring.id})).token);
  assert.equal(staffAudio.name,"Walshken Case Desk");assert.doesNotMatch(JSON.stringify(staffAudio),vulnerableFields);
  const room=audioGrant.video.room;
  assert.equal((await one(db,"SELECT connected_at FROM client_calls WHERE id=?",ring.id)).connected_at,null);
  const clientInfo={sid:"PA_client",identity:audioGrant.sub,kind:"STANDARD",state:"ACTIVE"};
  const companyInfo={sid:"PA_company",identity:staffAudio.sub,kind:"STANDARD",state:"ACTIVE"};
  people.set(room,[clientInfo,companyInfo]);
  const earlyEvent=randomUUID();
  await webhook("participant_joined",room,clientInfo,{},200,earlyEvent);
  assert.equal((await one(db,"SELECT status FROM client_calls WHERE id=?",ring.id)).status,"Accepted");
  await webhook("participant_joined",room,companyInfo);
  assert.equal((await call("client","activity",200,client)).calls[0].status,"Connected");
  await webhook("participant_joined",room,{sid:"intruder",identity:"foreign",kind:"STANDARD"});
  assert.deepEqual(withdrawals,["foreign"]);
  await webhook("egress_started",room,null,{egressInfo:{egressId:"EG_unexpected",roomName:room,status:"EGRESS_ACTIVE"}});
  assert.deepEqual(recordings,["EG_unexpected"]);
  await webhook("participant_left",room,companyInfo);
  assert.ok((await one(db,"SELECT reconnect_expires_at FROM client_calls WHERE id=?",ring.id)).reconnect_expires_at);
  await webhook("participant_joined",room,{...companyInfo,sid:"PA_reconnected"});
  assert.equal((await one(db,"SELECT reconnect_expires_at FROM client_calls WHERE id=?",ring.id)).reconnect_expires_at,null);
  await webhook("participant_joined",room,clientInfo,{},200,earlyEvent);
  assert.equal((await one(db,"SELECT count(*)::int AS count FROM client_call_provider_events WHERE id=?",earlyEvent)).count,1);
  assert.equal((await hook(new Request(`${origin}/api/livekit/webhook`,{method:"POST",body:"{}"}))).status,401);
  await call("staff","end",200,representative,{id:ring.id});
  assert.ok(!rooms.has(room));await call("client","token",409,client,{id:ring.id});

  const officeRing=(await call("client","start",201,client,{target:endpoint.id,mode:"Video"})).call;
  assert.equal(officeRing.contact,"Walshken Office");
  await call("staff","accept",404,representative,{id:officeRing.id});
  await call("staff","decline",200,office,{id:officeRing.id});
  assert.equal((await one(db,"SELECT status FROM client_calls WHERE id=?",officeRing.id)).status,"Declined");
  const outgoing=(await call("staff","start",201,representative,{case:caseId,mode:"Video"})).call;
  assert.ok(await one(db,"SELECT id FROM client_notifications WHERE customer_id=? AND dedupe_key=?",client.id,`client-call:${outgoing.id}`));
  await call("client","accept",200,client,{id:outgoing.id});
  const videoGrant=await verify.verify((await call("client","token",200,client,{id:outgoing.id})).token);
  assert.deepEqual(videoGrant.video.canPublishSources,["microphone","camera"]);
  assert.ok(!videoGrant.video.roomRecord&&!videoGrant.video.roomAdmin);
  await run(db,"UPDATE client_cases SET assigned_employee_id=?,representative_name=? WHERE id=?",office.id,"Support case alias",caseId);
  assert.equal((await call("client","activity",200,client)).calls.find(row=>row.id===outgoing.id).status,"Cancelled");
  assert.ok(!rooms.has(videoGrant.video.room));
  await call("staff","token",404,representative,{id:outgoing.id});
  const unpicked=(await call("client","start",201,peer,{case:peerCase,target:"representative",mode:"Video"})).call;
  await run(db,"UPDATE client_calls SET ring_expires_at=? WHERE id=?",later(-1),unpicked.id);
  assert.equal((await call("client","activity",200,peer)).calls.find(row=>row.id===unpicked.id).status,"Missed");
  const pollFallback=(await call("client","start",201,peer,{case:peerCase,target:"representative",mode:"Video"})).call;
  await call("staff","accept",200,representative,{id:pollFallback.id});
  const fallbackAudio=await verify.verify((await call("client","token",200,peer,{id:pollFallback.id})).token);
  const fallbackStaff=await verify.verify((await call("staff","token",200,representative,{id:pollFallback.id})).token);
  people.set(fallbackAudio.video.room,[{...clientInfo,identity:fallbackAudio.sub},{...companyInfo,identity:fallbackStaff.sub}]);
  assert.equal((await call("client","activity",200,peer)).calls.find(row=>row.id===pollFallback.id).status,"Connected","presence is reconciled through LiveKit when no webhook was delivered");
  await call("client","end",200,peer,{id:pollFallback.id});
  await call("staff","configure",409,admin,{id:endpoint.id,revision:343,name:endpoint.name,kind:endpoint.kind,employee:office.id,enabled:false});
  await call("staff","configure",200,admin,{id:endpoint.id,revision:endpoint.revision,name:endpoint.name,kind:endpoint.kind,employee:office.id,enabled:false});
  await call("client","start",404,client,{target:endpoint.id,mode:"Audio"});
  assert.ok(!JSON.stringify(await call("client","activity",200,client)).includes(peerCase));
  assert.ok(await one(db,"SELECT id FROM audit WHERE target_id=? AND action='Both participants connected to client call'",ring.id));
  console.log("PASS client calling scope, expected company alias privacy, office routing, ring/decline/miss/busy/unavailable, both directions, LiveKit media grants, reconnect, webhook isolation, egress stop, and revocation.");
}finally { globalThis.fetch=originalFetch; }
