import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo=process.cwd(), sandbox=mkdtempSync(join(tmpdir(),"walshken-client-communication-"));
mkdirSync(join(sandbox,"supabase","migrations"),{recursive:true});
symlinkSync(join(repo,"drizzle"),join(sandbox,"drizzle"),"dir");
for(const name of [
  "20261122145905_staff_document_security.sql",
  "20261122192455_employee_task_workflow.sql",
  "20261125231710_staff_unit_memberships.sql",
  "20261127090000_client_identity.sql",
  "20261127090200_client_cases.sql",
  "20261127090400_client_documents.sql",
  "20261127090700_client_calls.sql",
  "20261128101000_client_document_intelligence.sql",
  "20261128102000_client_appointments.sql",
  "20261128103000_client_message_feedback.sql",
  "20261128105000_client_preferences_and_mfa.sql",
])copyFileSync(join(repo,"supabase","migrations",name),join(sandbox,"supabase","migrations",name));
process.chdir(sandbox);
process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
delete process.env.DATABASE_URL;
Object.assign(process.env,{
  NODE_ENV:"test",WALSHKEN_CLIENT_PORTAL_ENABLED:"1",WALSHKEN_REQUIRE_STAFF_MFA:"0",
  WALSHKEN_INTEGRATION_KEY_V2:randomBytes(32).toString("base64"),
});
const {database,digest,now}=await import("../lib/walshken/server.ts");
const {issueClientSession}=await import("../lib/walshken/client-sessions.ts");
const {GET:messageGet,POST:messagePost}=await import("../app/api/client-conversations/[audience]/route.ts");
const {GET:feedbackGet,POST:feedbackPost}=await import("../app/api/client-feedback/[audience]/route.ts");
const {GET:legacyStaffGet}=await import("../app/api/client-casework/route.ts");
const db=database(),origin="https://preview.walshken.test";
const exec=(sql,...args)=>db.prepare(sql,args).run();
const one=(sql,...args)=>db.prepare(sql,args).first();
await exec("INSERT INTO organizations(id,name) VALUES('walshken','Walshken') ON CONFLICT(id) DO NOTHING");
async function client(name){
  const account={id:randomUUID(),name,email:name+"@client.invalid",side:"client"};
  await exec("INSERT INTO customers(id,name,email,password_hash,email_verified_at) VALUES(?,?,?,?,?)",account.id,account.name,account.email,"not-used",now());
  account.token=await issueClientSession(db,new Request(origin),account,false);
  return account;
}
async function employee(label,role){
  const actor={id:randomUUID(),token:randomUUID()+randomUUID(),side:"staff"};
  await exec("INSERT INTO employees(id,org_id,employee_no,name,email,role) VALUES(?,'walshken',?,?,?,?)",actor.id,actor.id,label,label+"@staff.invalid",role);
  await exec("INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,?,?)",await digest(actor.token),actor.id,new Date(Date.now()+3_600_000).toISOString(),"Isolated QA");
  return actor;
}
const owner=await client("owner"), other=await client("other"), agent=await employee("representative","employee"),
  desk=await employee("desk","employee"), outsider=await employee("outsider","employee"), superAdmin=await employee("admin","super_admin");
const endUser=(person)=>person.side==="client"?"walshken_customer":"walshken_session";
async function api(person,feature,status,{query="",data,crossOrigin}={}){
  const headers={cookie:endUser(person)+"="+person.token,origin:crossOrigin??origin};
  const config={headers};
  if(data!==undefined){
    Object.assign(config,{method:"POST",body:JSON.stringify(data)});
    headers["content-type"]="application/json";
  }
  const request=new Request(origin+"/api/client-"+feature+"/"+person.side+query,config);
  const [get,post]=feature==="feedback"?[feedbackGet,feedbackPost]:[messageGet,messagePost];
  const response=await (data===undefined?get:post)(request,{params:Promise.resolve({audience:person.side})});
  const body=await response.json();
  assert.equal(response.status,status,JSON.stringify(body));
  return body;
}
const cases=[];
for(const [i,customer] of [owner,other].entries()){
  const item=randomUUID(),stamp=now();
  await exec(`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,assigned_employee_id,representative_name,created_at,updated_at)
    VALUES(?,'walshken',?,?,?,'Immigration','CA',?,'Walshken Case Desk',?,?)`,item,customer.id,i?"WAL-OTHER":"WAL-OWN","Client case "+i,agent.id,stamp,stamp);
  const doc=randomUUID(),version=randomUUID();
  await exec(`INSERT INTO client_documents(id,org_id,case_id,customer_id,category,description,created_at,updated_at)
    VALUES(?,'walshken',?,?,'Passport','Fixture',?,?)`,doc,item,customer.id,stamp,stamp);
  await exec(`INSERT INTO client_document_versions(id,org_id,case_id,customer_id,document_id,upload_nonce,version,filename,mime,byte_size,sha256,
    storage_key,storage_backend,page_count,scan_status,submitted_at,retain_until)
    VALUES(?,'walshken',?,?,?,?,1,'passport.pdf','application/pdf',100,?,?, 'preview-db',1,'Clean',?,?)`,
    version,item,customer.id,doc,randomUUID(),"a".repeat(64),"fixture-"+version,stamp,stamp);
  cases.push({id:item,version});
}
const endpoint=randomUUID(),stamp=now();
await exec(`INSERT INTO client_call_endpoints(id,org_id,name,kind,employee_id,created_at,updated_at)
  VALUES(?,'walshken','Walshken Support','Support',?,?,?)`,endpoint,desk.id,stamp,stamp);
const target="?case="+cases[0].id, office=target+"&endpoint="+endpoint;
const message=(overrides={})=>({action:"send",case:cases[0].id,body:"My passport is ready for review.",requestId:randomUUID(),...overrides});
const mainMessage=message({attachment:cases[0].version});
await api(owner,"conversations",403,{data:mainMessage,crossOrigin:"https://different.invalid"});
await api(owner,"conversations",404,{data:message({attachment:cases[1].version})});
await api(other,"conversations",404,{query:target});
await api(outsider,"conversations",404,{query:target});
await api(owner,"conversations",201,{data:mainMessage});
await api(owner,"conversations",200,{data:mainMessage});
await api(owner,"conversations",409,{data:{...mainMessage,body:"Request reference reuse with changed contents"}});
assert.equal((await api(agent,"conversations",200,{query:target})).messages[0].filename,"passport.pdf");
assert.equal((await api(agent,"conversations",200,{query:target})).unread,1);
await api(agent,"conversations",200,{data:{action:"read",case:cases[0].id,messages:[mainMessage.requestId]}});
assert.equal((await api(agent,"conversations",200,{query:target})).unread,0);
assert((await api(owner,"conversations",200,{query:target})).messages[0].recipient_read_at);

const reply=message({body:"We have received the document."});
await api(agent,"conversations",201,{data:reply});
const ownView=await api(owner,"conversations",200,{query:target});
assert.equal(ownView.unread,1);
assert.equal(ownView.messages.at(-1).display_name,"Walshken Case Desk");
assert(!JSON.stringify(ownView).includes("representative@staff.invalid"));
await api(owner,"conversations",200,{data:{action:"read",case:cases[0].id,messages:[reply.requestId]}});
assert((await api(agent,"conversations",200,{query:target})).messages.at(-1).recipient_read_at);

await api(desk,"conversations",404,{query:office});
await api(owner,"conversations",403,{data:message({endpoint,attachment:cases[0].version})});
const routed=message({endpoint,body:"An office scheduling question."});
await api(owner,"conversations",201,{data:routed});
assert.equal((await api(desk,"conversations",200)).inbox[0].unread,1);
const officeHistory=await api(desk,"conversations",200,{query:office});
assert.equal(officeHistory.messages[0].body,routed.body);
assert.equal(officeHistory.messages.length,1);
assert(!JSON.stringify(officeHistory).includes(mainMessage.body));
await api(desk,"conversations",404,{query:target});
await api(agent,"conversations",404,{query:office});
await api(desk,"conversations",200,{data:{action:"read",case:cases[0].id,endpoint,messages:[routed.requestId]}});
assert.equal((await api(desk,"conversations",200)).inbox[0].unread,0);
await api(desk,"conversations",201,{data:message({endpoint,body:"Our office will assist."})});
assert.equal((await api(owner,"conversations",200,{query:office})).messages.at(-1).display_name,"Walshken Support");
const legacy=await legacyStaffGet(new Request(origin+"/api/client-casework"+target,{headers:{cookie:"walshken_session="+agent.token}}));
assert.equal(legacy.status,200);
assert(!(await legacy.json()).messages.some(row=>row.body===routed.body));
await exec("UPDATE client_call_endpoints SET enabled=false WHERE id=?",endpoint);
await api(desk,"conversations",404,{query:office});
assert.equal((await api(owner,"conversations",200,{query:office})).writable,false);
await api(owner,"conversations",409,{data:message({endpoint})});
assert.equal(await one("SELECT count(*)::int AS n FROM client_case_message_receipts").then(row=>row.n),3);
console.log("PASS representative continuity, office delegation and revocation, scoped read receipts and unread count, company aliases, safe flags and version-bound attachments");

const feedback=(overrides={})=>({kind:"Complaint",title:"Confidential concern",body:"Please review how my request was handled.",case:cases[0].id,requestId:randomUUID(),...overrides});
const complaint=feedback();
await api(owner,"feedback",201,{data:complaint});
await api(owner,"feedback",200,{data:complaint});
await api(other,"feedback",404,{query:"?id="+complaint.requestId});
await api(agent,"feedback",403);
await api(desk,"feedback",403);
const queue=await api(superAdmin,"feedback",200);
assert.equal(queue.entries[0].body,"");
assert.equal(queue.report.totals.complaints,1);
assert.equal((await api(superAdmin,"feedback",200,{query:"?id="+complaint.requestId})).entries[0].body,complaint.body);
await api(superAdmin,"feedback",200,{data:{id:complaint.requestId,revision:1,status:"In review"}});
await api(superAdmin,"feedback",409,{data:{id:complaint.requestId,revision:1,status:"Responded",body:"We are looking into the issue."}});
await api(superAdmin,"feedback",200,{data:{id:complaint.requestId,revision:2,status:"Responded",body:"Our office reviewed your concern."}});
const history=await api(owner,"feedback",200,{query:"?id="+complaint.requestId});
assert.equal(history.entries[0].status,"Responded");
assert.equal(history.replies[0].body,"Our office reviewed your concern.");
assert(!Object.hasOwn(history.replies[0],"employee_id"));
await api(owner,"feedback",409,{data:feedback({kind:"Case closure feedback",rating:5})});
await exec("UPDATE client_cases SET client_status='Closed' WHERE id=?",cases[0].id);
await api(owner,"feedback",201,{data:feedback({kind:"Case closure feedback",rating:5})});
await api(owner,"feedback",409,{data:feedback({kind:"Case closure feedback",rating:5})});
await api(owner,"feedback",201,{data:feedback({kind:"Service rating",rating:3})});
await api(owner,"feedback",201,{data:feedback({kind:"Support request",case:""})});
const appointment=randomUUID(),slot=randomUUID(),before=new Date(Date.now()-7_200_000).toISOString(),after=new Date(Date.now()-3_600_000).toISOString();
await exec(`INSERT INTO client_appointment_slots (id,org_id,employee_id,published_by,starts_at,ends_at,time_zone,mode,created_at)
  VALUES(?,'walshken',?,?,?,?,'UTC','Video',?)`,slot,agent.id,superAdmin.id,before,after,stamp);
await exec(`INSERT INTO client_appointments (id,org_id,case_id,customer_id,employee_id,slot_id,representative_name,starts_at,ends_at,time_zone,
  mode,status,created_at,updated_at) VALUES(?,'walshken',?,?,?,?,'Walshken Case Desk',?,?,'UTC','Video','Completed',?,?)`,
  appointment,cases[0].id,owner.id,agent.id,slot,before,after,stamp,stamp);
const consultation=feedback({kind:"Consultation feedback",rating:4,appointment,case:""});
await api(other,"feedback",404,{data:consultation});
assert.equal((await api(owner,"feedback",200)).consultations[0].id,appointment);
await api(owner,"feedback",201,{data:consultation});
await api(owner,"feedback",409,{data:{...consultation,requestId:randomUUID()}});
assert.equal((await api(owner,"feedback",200)).consultations.length,0);
const totals=(await api(superAdmin,"feedback",200)).report.totals;
assert.deepEqual(totals,{submissions:5,complaints:1,outstanding:5,average:"4.00"});
await assert.rejects(()=>exec("DELETE FROM client_feedback_responses"),/immutable/);
console.log("PASS confidential complaints, assistance and feedback, actual consultation eligibility, closed-case ratings, audited replies and authentic date-range analytics");

await api(other,"feedback",201,{data:feedback({case:cases[1].id})});
await exec("CREATE ROLE communication_scope_test");
for(const table of ["client_case_message_receipts","client_feedback_submissions","client_feedback_responses"]){
  await exec("GRANT SELECT ON "+table+" TO communication_scope_test");
  await exec("CREATE POLICY communication_scope_test ON "+table+" FOR SELECT TO communication_scope_test USING(true)");
}
await db.transaction(async tx=>{
  await tx.prepare("SET LOCAL ROLE communication_scope_test",[]).run();
  await tx.prepare("SELECT set_config('walshken.client_customer_id',?,true)",[other.id]).run();
  const count=async table=>(await tx.prepare("SELECT count(*)::int AS n FROM "+table,[]).first()).n;
  assert.equal(await count("client_feedback_submissions"),1);
  assert.equal(await count("client_feedback_responses"),0);
  assert.equal(await count("client_case_message_receipts"),0);
});
console.log("PASS direct database customer RLS for restricted feedback, responses and receipts");
