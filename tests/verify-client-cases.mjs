import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const repo=process.cwd(),sandbox=mkdtempSync(join(tmpdir(),"walshken-client-case-test-"));
mkdirSync(join(sandbox,"supabase","migrations"),{recursive:true});
symlinkSync(join(repo,"drizzle"),join(sandbox,"drizzle"),"dir");
for(const name of [
  "20261122145905_staff_document_security.sql",
  "20261122192455_employee_task_workflow.sql",
  "20261125231710_staff_unit_memberships.sql",
  "20261127090000_client_identity.sql",
  "20261127090200_client_cases.sql",
  "20261127090400_client_documents.sql",
  "20261127090600_client_finance.sql",
  "20261127090700_client_calls.sql",
]){
  copyFileSync(join(repo,"supabase","migrations",name),join(sandbox,"supabase","migrations",name));
}
process.chdir(sandbox);
process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
delete process.env.DATABASE_URL;
process.env.NODE_ENV="test";
process.env.WALSHKEN_CLIENT_PORTAL_ENABLED="1";
process.env.WALSHKEN_INTEGRATION_KEY=randomBytes(32).toString("base64");
const {database,digest,now}=await import("../lib/walshken/server.ts");
const {issueClientSession,rawClientSession}=await import("../lib/walshken/client-sessions.ts");
const {staffCaseAction,staffCaseView,assertClientCaseUnheld}=await import("../lib/walshken/client-cases.ts");
const {staffClientPrivacyAction}=await import("../lib/walshken/client-case-privacy.ts");
const {GET,POST}=await import("../app/api/client-cases/route.ts");
const {GET:STAFF_GET,POST:STAFF_POST}=await import("../app/api/client-casework/route.ts");
const db=database(),site="https://test.walshken.test";
const write=(sql,...args)=>db.prepare(sql,args).run();
const one=(sql,...args)=>db.prepare(sql,args).first();
await write("INSERT INTO organizations(id,name) VALUES('walshken','Walshken') ON CONFLICT(id) DO NOTHING");
for(const unit of ["unit-one","unit-two"])await write("INSERT INTO units(id,org_id,kind,name) VALUES(?,'walshken','Department',?)",unit,unit);
async function employee(id,role,department=null) {
  await write("INSERT INTO employees(id,org_id,employee_no,name,email,role,department_id) VALUES(?,'walshken',?,?,?,?,?)",id,id,id,id+"@staff.invalid",role,department);
  return one("SELECT * FROM employees WHERE id=?",id);
}
const admin=await employee("admin","super_admin"),backup=await employee("backup","super_admin"),
  departmentAdmin=await employee("sector-admin","admin","unit-one"),strangerAdmin=await employee("wrong-admin","admin","unit-two"),
  rep=await employee("rep","employee","unit-one"),newRep=await employee("next","employee","unit-one"),outsider=await employee("outsider","employee","unit-two");
const employeeToken=randomUUID()+randomUUID();
await write("INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,?,?)",await digest(employeeToken),rep.id,new Date(Date.now()+3600_000).toISOString(),"Isolated QA browser");

async function account(name) {
  const row={id:randomUUID(),name,email:name+"@client.invalid"};
  await write("INSERT INTO customers(id,name,email,password_hash,email_verified_at) VALUES(?,?,?,?,?)",row.id,row.name,row.email,"unused-by-fixture",now());
  row.token=await issueClientSession(db,new Request(site),row,false);
  return row;
}
const client=await account("case-client"),stranger=await account("unrelated"),unverified=await account("unverified");
await write("UPDATE customers SET email_verified_at=NULL WHERE id=?",unverified.id);
async function request(query,account,expected,body) {
  const init={headers:{cookie:"walshken_customer="+account.token,origin:site}};
  if(body!==undefined)Object.assign(init,{method:"POST",body:JSON.stringify(body),headers:{...init.headers,"content-type":"application/json"}});
  const response=await (body===undefined?GET:POST)(new Request(site+"/api/client-cases"+query,init));
  const data=await response.json();
  assert.equal(response.status,expected,JSON.stringify(data));
  return data;
}
const parse=async response=>response.json();
const requestId=randomUUID(),initial={action:"submit",title:"Residence case",service:"Residency assessment",country:"CA",message:"Private filing from the client",requestId};
await request("",unverified,403,initial);
const filing=await request("",client,201,initial);
assert.match(filing.reference,/^WAL-[0-9A-F]{12}$/);
assert.equal((await request("",client,200,initial)).id,filing.id);
assert.equal((await request("",client,200)).cases.length,1);
await request("?case="+filing.id,stranger,404);
assert.equal((await STAFF_GET(new Request(site+"/api/client-casework?case="+filing.id,{headers:{cookie:"walshken_customer="+client.token}}))).status,401);
assert.equal((await STAFF_GET(new Request(site+"/api/client-casework?case="+filing.id,{headers:{cookie:"walshken_session="+employeeToken}}))).status,404);
assert.equal((await staffCaseView(db,admin,filing.id)).messages[0].body,initial.message);
await assert.rejects(()=>staffCaseView(db,outsider,filing.id),{status:404});
await assert.rejects(()=>staffCaseView(db,departmentAdmin,filing.id),{status:404});
const change=(actor,action,data)=>staffCaseAction(db,actor,action,{case:filing.id,...data});
const read=async()=>request("?case="+filing.id,client,200);
const supplied={revision:1,employee:rep.id,representativeName:"Immigration Services Desk",designation:"Client representative"};
await assert.rejects(()=>change(admin,"assign",{...supplied,representativeName:"representative@private.invalid"}),{status:400});
await change(admin,"assign",supplied);
assert.equal((await STAFF_GET(new Request(site+"/api/client-casework?case="+filing.id,{headers:{cookie:"walshken_session="+employeeToken}}))).status,200);
assert.equal((await STAFF_POST(new Request(site+"/api/client-casework",{method:"POST",headers:{cookie:"walshken_session="+employeeToken,origin:"https://untrusted.invalid","content-type":"application/json"},body:JSON.stringify({action:"note",case:filing.id,body:"Origin guard"})}))).status,403);
assert.equal((await staffCaseView(db,departmentAdmin,filing.id)).canManage,true);
await assert.rejects(()=>staffCaseView(db,strangerAdmin,filing.id),{status:404});
assert.equal((await read()).case.representative_name,supplied.representativeName);
const before=(await read()).case.updated_at;
await change(rep,"note",{body:"Unpublished internal legal note"});
await change(rep,"internal-status",{revision:2,status:"Assessing"});
await change(rep,"propose",{revision:3,title:"Filing milestone",body:"Company-approved wording",status:"Submitted",submissionDate:"2026-11-22"});
let visible=await read();
assert.equal(visible.case.updated_at,before,"Private work must not change client-visible activity");
assert.equal(visible.case.client_status,"Received");
assert.equal(visible.updates.length,0);
assert(!JSON.stringify(visible).includes("Unpublished internal legal note"));
assert(!JSON.stringify(visible).includes("assigned_employee_id"));
const update=(await staffCaseView(db,rep,filing.id)).updates[0];
await assert.rejects(()=>change(rep,"review",{revision:4,update:update.id,decision:"Published",reviewNote:"No publish scope"}),{status:403});
await change(departmentAdmin,"review",{revision:4,update:update.id,decision:"Published",reviewNote:"Private publish review"});
visible=await read();
assert.equal(visible.case.client_status,"Submitted");
assert.equal(visible.case.application_submitted_on,"2026-11-22");
assert.equal(visible.updates[0].body,"Company-approved wording");
assert(!JSON.stringify(visible).includes("Private publish review"));
await change(rep,"request-document",{revision:5,title:"Travel identity",instructions:"Submit your requested identification securely.",due:"2027-01-15"});
assert.equal((await read()).requests[0].status,"Open");
const requirement=(await read()).requests[0];
await change(rep,"edit-document",{revision:6,request:requirement.id,title:requirement.title,instructions:requirement.instructions,due:"2027-01-28"});
assert.equal((await read()).requests[0].due_on,"2027-01-28");
await request("",client,201,{action:"message",case:filing.id,body:"Documents will follow"});
await change(rep,"message",{body:"Thank you for the update."});
assert.equal((await read()).messages.at(-1).display_name,supplied.representativeName);
assert(!JSON.stringify(await read()).includes(rep.email));
await change(departmentAdmin,"assign",{...supplied,revision:7,employee:newRep.id,representativeName:"Client Liaison"});
await assert.rejects(()=>staffCaseView(db,rep,filing.id),{status:404});
assert.equal((await staffCaseView(db,admin,filing.id)).assignments.filter(item=>item.ended_at).length,1);
await change(departmentAdmin,"client-access",{revision:8,enabled:false});
await request("",client,409,{action:"message",case:filing.id,body:"Blocked while paused"});
assert.equal((await read()).case.communication_enabled,false);
await assert.rejects(()=>write("DELETE FROM client_case_assignments WHERE case_id=?",filing.id),/immutable/);
await assert.rejects(()=>write("UPDATE client_case_updates SET body='altered' WHERE id=?",update.id),/immutable/);
console.log("PASS verified-only intake, idempotency, ownership, department scope, aliases, private internal status and timestamps, independent publication, requests and immediate communication/reassignment revocation");

await staffClientPrivacyAction(db,admin,"privacy-policy",{notice:"Company-approved sample policy for this isolated workflow.",reference:"https://test.walshken.test/policy",retentionDays:365});
const policy=(await read()).privacyPolicy;
await request("",client,409,{action:"consent",case:filing.id,policyRevision:"stale",decision:"Accepted"});
await request("",client,201,{action:"consent",case:filing.id,policyRevision:policy.id,decision:"Accepted"});
await request("",client,200,{action:"consent",case:filing.id,policyRevision:policy.id,decision:"Accepted"});
assert.equal((await read()).consents.length,1);
await request("",stranger,404,{action:"privacy-request",case:filing.id,type:"Data access",reason:"Outside client"});
const access=await request("",client,201,{action:"privacy-request",case:filing.id,type:"Data export",reason:"Request a copy of my case"});
await request("?export="+access.id,client,404);
const exportCall=randomUUID(),invoice=randomUUID(),agreement=randomUUID(),version=randomUUID();
await write(`INSERT INTO client_calls(id,org_id,customer_id,case_id,employee_id,company_name,client_name,initiator,mode,status,provider_room,created_at,ring_expires_at,ended_at)
  VALUES(?,'walshken',?,?,?,'Client Liaison','Case customer','client','Audio','Ended',?,?,?,?)`,
  exportCall,client.id,filing.id,newRep.id,"wk-client-"+exportCall,now(),now(),now());
await write(`INSERT INTO client_invoices(id,org_id,case_id,customer_id,invoice_number,issuer_name,issuer_address,recipient_name,recipient_email,
  currency,issue_on,due_on,subtotal_minor,tax_minor,total_minor,status,created_by,created_at,updated_at)
  VALUES(?,'walshken',?,?,'QA-INVOICE-1','Walshken QA','QA company address',?,?,'CAD','2026-11-22','2027-01-01',1000,0,1000,'Open',?,?,?)`,
  invoice,filing.id,client.id,client.name,client.email,admin.id,now(),now());
await write("INSERT INTO client_agreements(id,org_id,case_id,customer_id,created_by,created_at) VALUES(?,'walshken',?,?,?,?)",
  agreement,filing.id,client.id,admin.id,now());
await write(`INSERT INTO client_agreement_versions(id,org_id,agreement_id,version,title,issuer_name,terms,content_hash,created_by,created_at,published_by,published_at)
  VALUES(?,'walshken',?,1,'Case agreement','Walshken QA','Synthetic approved terms',?,?,?,?,?)`,version,agreement,"a".repeat(64),admin.id,now(),admin.id,now());
await staffClientPrivacyAction(db,admin,"privacy-decision",{request:access.id,revision:1,decision:"Approved",reason:"Internal authorization evidence",response:"Your case export is available."});
const exported=await request("?export="+access.id,client,200);
assert.equal(exported.cases[0].case.id,filing.id);
assert.equal(exported.calls[0].company_name,"Client Liaison");
assert.equal(exported.invoices[0].invoice_number,"QA-INVOICE-1");
assert.equal(exported.agreements[0].terms,"Synthetic approved terms");
assert(!JSON.stringify(exported).includes("wk-client-"));
assert(!Object.hasOwn(exported.calls[0],"employee_id"));
assert(!Object.hasOwn(exported.invoices[0],"created_by"));
assert(!JSON.stringify(exported).includes("Internal authorization evidence"));
await request("?export="+access.id,stranger,404);
const hold=await parse(await staffClientPrivacyAction(db,admin,"privacy-hold",{customer:client.id,reason:"Account-wide retention hold"}));
await assert.rejects(()=>assertClientCaseUnheld(db,filing.id,client.id),{status:409});
await assert.rejects(()=>staffClientPrivacyAction(db,admin,"privacy-release",{hold:hold.id,reason:"Independent reviewer required"}),{status:403});
await staffClientPrivacyAction(db,backup,"privacy-release",{hold:hold.id,reason:"Release independently approved"});
await assertClientCaseUnheld(db,filing.id,client.id);
const deletion=await request("",client,201,{action:"privacy-request",case:filing.id,type:"Document deletion",reason:"Review the requested file"});
await staffClientPrivacyAction(db,admin,"privacy-decision",{request:deletion.id,revision:1,decision:"Approved",reason:"Approved for retention review",response:"We are reviewing the file."});
await assert.rejects(()=>staffClientPrivacyAction(db,admin,"privacy-decision",{request:deletion.id,revision:2,decision:"Completed",disposal:randomUUID(),reason:"Missing completed object destruction",response:"File disposed."}),{status:409});
const closure=await request("",client,201,{action:"privacy-request",type:"Account closure",reason:"Close my account"});
await staffClientPrivacyAction(db,admin,"privacy-decision",{request:closure.id,revision:1,decision:"Approved",reason:"Account owner request",response:"Request approved."});
await staffClientPrivacyAction(db,admin,"privacy-decision",{request:closure.id,revision:2,decision:"Completed",reason:"Account access revoked",response:"Account closed."});
assert.equal(await rawClientSession(db,client.token),null);
await request("",client,401);
assert.equal((await staffCaseView(db,admin,filing.id)).case.id,filing.id,"Closure preserves retained case records");
console.log("PASS versioned consent, cross-client privacy isolation, approved export, independent hold release, deletion evidence and immediate account/session closure");
