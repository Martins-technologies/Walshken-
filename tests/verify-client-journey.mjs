import assert from "node:assert/strict";
import { copyFileSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes,randomUUID } from "node:crypto";

assert.equal(process.env.NODE_ENV,"test");
assert.equal(process.env.DATABASE_URL,undefined);
const repo=process.cwd(),sandbox=mkdtempSync(join(tmpdir(),"walshken-journey-"));
mkdirSync(join(sandbox,"supabase","migrations"),{recursive:true});
symlinkSync(join(repo,"drizzle"),join(sandbox,"drizzle"),"dir");
const folder=join(sandbox,"supabase","migrations");
writeFileSync(join(folder,"19991231000000_fixture_organization.sql"),"INSERT INTO organizations(id,name) VALUES('walshken','Walshken') ON CONFLICT(id) DO NOTHING;");
for(const name of [
  "20261122145905_staff_document_security.sql","20261122192455_employee_task_workflow.sql","20261125231710_staff_unit_memberships.sql",
  "20261127090000_client_identity.sql","20261127090200_client_cases.sql","20261127090400_client_documents.sql",
  "20261127090600_client_finance.sql","20261127090700_client_calls.sql","20261128100000_client_journey.sql",
  "20261128101000_client_document_intelligence.sql","20261128105000_client_preferences_and_mfa.sql",
])copyFileSync(join(repo,"supabase","migrations",name),join(folder,name));
process.chdir(sandbox);
process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
Object.assign(process.env,{WALSHKEN_CLIENT_PORTAL_ENABLED:"1",WALSHKEN_INTEGRATION_KEY:randomBytes(32).toString("base64")});
const {database,digest,now}=await import("../lib/walshken/server.ts");
const {issueClientSession}=await import("../lib/walshken/client-sessions.ts");
const {GET,POST}=await import("../app/api/client-journey/route.ts");
const {staffClientPrivacyAction}=await import("../lib/walshken/client-case-privacy.ts");
const db=database(),site="https://journey.walshken.test",stamp=now(),future=new Date(Date.now()+3_600_000).toISOString();
const write=(sql,...params)=>db.prepare(sql,params).run();
const one=(sql,...params)=>db.prepare(sql,params).first();
async function staff(id,role){
  const token=randomUUID()+randomUUID();
  await write("INSERT INTO employees(id,org_id,employee_no,name,email,role) VALUES(?,'walshken',?,?,?,?)",id,id,id,id+"@staff.test",role);
  await write("INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,?,'Journey fixture')",await digest(token),id,future);
  return {id,staff:true,cookie:"walshken_session="+token};
}
async function client(name,verified=true){
  const row={id:randomUUID(),name,email:name+"@client.test"};
  await write("INSERT INTO customers(id,name,email,password_hash,email_verified_at) VALUES(?,?,?,'fixture',?)",row.id,row.name,row.email,verified?stamp:null);
  const token=await issueClientSession(db,new Request(site),row,false);
  return {...row,token,cookie:"walshken_customer="+token};
}
const author=await staff("author","employee"),admin=await staff("reviewer","super_admin"),unrelated=await staff("unrelated","employee");
const customer=await client("customer"),other=await client("other"),unverified=await client("unverified",false);
const caseId=randomUUID(),otherCase=randomUUID();
for(const [target,account,index] of [[caseId,customer,1],[otherCase,other,2]]){
  await write(`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,assigned_employee_id,representative_name,created_at,updated_at)
    VALUES(?,'walshken',?,?,'Immigration case','Consultation','CA',?,'Walshken representative',?,?)`,target,account.id,"WK-JOURNEY-"+index,author.id,stamp,stamp);
}
const request=async (actor,status,{body,case:target=caseId,overview,dependant,origin=site}={})=>{
  const query=new URLSearchParams();
  if(actor?.staff)query.set("audience","staff");
  if(target)query.set("case",target);
  if(overview)query.set("overview","1");
  if(dependant)query.set("dependant",dependant);
  const init={headers:{...(actor?{cookie:actor.cookie}:{}),origin}};
  if(body)Object.assign(init,{method:"POST",body:JSON.stringify({case:target,...body}),headers:{...init.headers,"content-type":"application/json"}});
  const response=await (body?POST:GET)(new Request(site+"/api/client-journey?"+query,init));
  const data=await response.json();
  assert.equal(response.status,status,JSON.stringify(data));
  assert.match(response.headers.get("cache-control"),/no-store/);
  return data;
};
await request(null,401);
await request(other,404);
await request(unverified,403);
await request(unrelated,404);
assert.equal((await request(author,200)).stages.length,9);
const primary=await request(admin,200,{body:{action:"stage-create",title:"Credential check",position:55,enabled:true,description:"Team-only guidance."}});
await request(author,403,{body:{action:"stage-edit",stage:primary.id,title:"Invalid",position:1,enabled:true,revision:1}});
const proposal={action:"milestone-submit",stage:primary.id,state:"In progress",details:"Initial evidence is being checked.",nextAction:"Upload your passport.",eventOn:"2026-11-20"};
await request(author,403,{body:proposal,origin:"https://elsewhere.test"});
const milestone=await request(author,200,{body:proposal});
assert.equal((await request(customer,200)).milestones.length,0);
assert.equal((await request(author,200)).milestones[0].decision,"Pending");
await request(author,403,{body:{action:"milestone-review",milestone:milestone.id,decision:"Published"}});
await request(admin,200,{body:{action:"milestone-review",milestone:milestone.id,decision:"Published",note:"Internal reviewer note"}});
const published=(await request(customer,200)).milestones[0];
assert.equal(published.next_action,"Upload your passport.");
assert.equal(published.stage_title,"Credential check");
assert(!JSON.stringify(published).includes("Internal reviewer note"));
await request(admin,200,{body:{action:"stage-edit",stage:primary.id,title:"New stage title",position:58,enabled:false,revision:1}});
assert.equal((await request(customer,200)).milestones[0].stage_title,"Credential check");
await request(author,404,{body:proposal});
const ownDraft=await request(admin,200,{body:{...proposal,stage:"walshken:consultation"}});
await request(admin,403,{body:{action:"milestone-review",milestone:ownDraft.id,decision:"Published"}});
assert.deepEqual((await request(customer,200)).milestones.map(item=>item.id),[milestone.id]);

const task=await request(author,200,{body:{action:"task-create",title:"Confirm your contact information",details:"Tell us when it is updated.",kind:"confirmation",status:"Open",dueOn:"2027-01-12"}});
const requirement=randomUUID(),invoice=randomUUID();
await write(`INSERT INTO client_case_document_requests(id,org_id,case_id,title,instructions,due_on,created_by,created_at,updated_at)
  VALUES(?,'walshken',?,'Upload an identity record','Use the requested category.','2027-01-05',?,?,?)`,requirement,caseId,author.id,stamp,stamp);
await write(`INSERT INTO client_invoices(id,org_id,case_id,customer_id,invoice_number,issuer_name,issuer_address,recipient_name,recipient_email,
  currency,issue_on,due_on,subtotal_minor,tax_minor,total_minor,status,created_by,created_at,updated_at)
  VALUES(?,'walshken',?,?,'QA-JOURNEY-1','Walshken QA','QA address',?,?,'CAD','2026-11-22','2027-01-01',1000,0,1000,'Open',?,?,?)`,
  invoice,caseId,customer.id,customer.name,customer.email,admin.id,stamp,stamp);
const actions=(await request(customer,200,{case:"",overview:true})).actions;
assert(actions.some(item=>item.id===task.id&&item.status==="Open"));
assert(actions.some(item=>item.id===requirement&&item.kind==="documents"));
assert(actions.some(item=>item.id===invoice&&item.kind==="payments"));
assert(actions.some(item=>item.id==="profile"));
await request(other,404,{body:{action:"task-complete",task:task.id,revision:1}});
await request(customer,200,{body:{action:"task-complete",task:task.id,revision:1}});
await request(customer,409,{body:{action:"task-complete",task:task.id,revision:1}});
assert.equal((await request(author,200)).tasks[0].status,"Completed");
assert(!(await request(customer,200)).actions.some(item=>item.id===task.id));

const family={action:"family-add",name:"Fictional Dependant",relationship:"Child",birthDate:"2018-02-10",passport:"DOC-04244",passportCountry:"CA",passportExpiry:"2030-06-01"};
const dependant=await request(customer,200,{body:family});
const stored=await one("SELECT encrypted_details FROM client_dependants WHERE id=?",dependant.id);
assert(!stored.encrypted_details.includes(family.name)&&!stored.encrypted_details.includes(family.passport));
const list=(await request(customer,200)).family.dependants;
assert.equal(list[0].name,family.name);
assert(!JSON.stringify(list).includes(family.passport));
assert.equal((await request(customer,200,{dependant:dependant.id})).details.passport,family.passport);
assert.equal((await request(author,200,{dependant:dependant.id})).details.birthDate,family.birthDate);
await request(unrelated,404,{dependant:dependant.id});
await request(customer,404,{case:otherCase,dependant:dependant.id});
await write("UPDATE customer_sessions SET reauthenticated_at=? WHERE id=?","2000-01-01",await digest(customer.token));
await request(customer,403,{dependant:dependant.id});
await request(customer,403,{body:family});
await write("UPDATE customer_sessions SET reauthenticated_at=? WHERE id=?",stamp,await digest(customer.token));

const doc=randomUUID(),strangerDoc=randomUUID();
for(const [document,target,account] of [[doc,caseId,customer],[strangerDoc,otherCase,other]]) {
  await write(`INSERT INTO client_documents(id,org_id,case_id,customer_id,category,description,created_at,updated_at)
    VALUES(?,'walshken',?,?,'Passport','Family identity',?,?)`,document,target,account.id,stamp,stamp);
  await write(`INSERT INTO client_document_versions(id,org_id,case_id,customer_id,document_id,upload_nonce,version,filename,mime,byte_size,sha256,
    storage_key,storage_backend,page_count,scan_status,submitted_at,retain_until)
    VALUES(?,'walshken',?,?,?, ?,1,'family.pdf','application/pdf',120,?,?,'preview-db',1,'Scanning deferred',?,?)`,
    randomUUID(),target,account.id,document,randomUUID(),"a".repeat(64),"fixture/"+document,stamp,future);
}
await request(customer,404,{body:{action:"family-link",dependant:dependant.id,document:strangerDoc}});
await request(customer,200,{body:{action:"family-link",dependant:dependant.id,document:doc}});
assert.equal((await request(author,200)).family.dependants[0].documents[0].id,doc);
const adminActor=await one("SELECT * FROM employees WHERE id=?",admin.id);
await staffClientPrivacyAction(db,adminActor,"privacy-hold",{customer:customer.id,case:caseId,reason:"Fictional QA retention hold"});
await request(customer,409,{body:{action:"family-archive",dependant:dependant.id,revision:1}});
assert.equal((await request(customer,200)).family.dependants.length,1);

await write("CREATE ROLE journey_test_runtime NOLOGIN NOBYPASSRLS");
for(const name of ["client_workflow_stages","client_case_milestones","client_action_tasks","client_dependants","client_dependant_documents"]){
  await write("GRANT SELECT ON "+name+" TO journey_test_runtime");
  await write("CREATE POLICY fixture_runtime ON "+name+" FOR SELECT TO journey_test_runtime USING(true)");
}
await db.transaction(async tx=>{
  await tx.prepare("SET LOCAL ROLE journey_test_runtime",[]).run();
  await tx.prepare("SELECT set_config('walshken.client_customer_id',?,true)",[customer.id]).run();
  const rows=await tx.prepare("SELECT id FROM client_case_milestones",[]).all();
  assert.deepEqual(rows.results,[{id:milestone.id}]);
  assert.equal((await tx.prepare("SELECT id FROM client_workflow_stages",[]).all()).results.length,0);
  assert.deepEqual((await tx.prepare("SELECT id FROM client_dependants",[]).all()).results,[{id:dependant.id}]);
});
await db.transaction(async tx=>{
  await tx.prepare("SET LOCAL ROLE journey_test_runtime",[]).run();
  await tx.prepare("SELECT set_config('walshken.client_customer_id',?,true)",[other.id]).run();
  for(const table of ["client_case_milestones","client_action_tasks","client_dependants","client_dependant_documents"]){
    assert.equal((await tx.prepare("SELECT * FROM "+table,[]).all()).results.length,0);
  }
});
console.log("PASS independent timeline publication and stage settings, record-backed actions, secure family editing and document associations, legal holds, and non-owner RLS");
